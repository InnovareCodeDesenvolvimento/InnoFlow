import bcrypt from 'bcryptjs'
import type Redis from 'ioredis'
import { incrWithTtl } from '../../lib/redisCounter'
import { withDeadline } from '../../lib/withDeadline'
import {
  contaPodeConsumirToken,
  decidirSolicitacao,
  formatoDeTokenValido,
  hashDoEmail,
  hashDoIp,
  impressaoDaSenha,
  montarLinkDeRedefinicao,
  TTL_TOKEN_REDEFINICAO_SEGUNDOS,
  type ContaParaRedefinicao,
} from '../../core/auth/redefinicaoSenha'
import { emailDeAvisoGoogle, emailDeRedefinicao, emailDeSenhaAlterada, formatarQuando, type EmailPronto } from '../../core/auth/emailsDeSenha'
import type { PortaDeTokensDeRedefinicao } from './tokensRedefinicaoRedis'
import type { WriteAuditLogInput } from '../auditoria/writeAuditLog'
import type { ResultadoEmailTransacional } from '../comunicacao/email'

/**
 * Serviço da redefinição de senha por e-mail (L1.3) — "esqueci minha senha" (`solicitar`) e o clique no link (`redefinir`). FÁBRICA com tudo injetado (Redis, banco, SMTP, relógio,
 * log): não importa `env`/Prisma/logger, então a lógica roda em teste sem infraestrutura; `redefinicaoSenhaInstancia.ts` liga as peças reais.
 *
 * `solicitar` roda FORA do caminho da resposta (a rota responde 202 antes — ver `lib/filaEmBackground.ts`): nunca lança, nunca devolve nada ao cliente, e é onde mora tudo que
 * difere entre "e-mail existe" e "não existe" (consulta, Redis, SMTP). Limites aqui dentro, todos SILENCIOSOS (a resposta já foi 202):
 *  - por e-mail (hash): 3 por hora; o contador sobe para qualquer e-mail, existente ou não (não vira oráculo e não deixa o atacante "esgotar" só contas reais);
 *  - global: teto de e-mails realmente enviados por hora (SMTP do dono não vira relé).
 * `redefinir` valida o token (uso único, atômico), re-checa a conta, troca a senha E revoga as sessões E audita numa transação só. Falha NOSSA depois de consumir o token
 * (banco fora) devolve o token (melhor esforço) para o link continuar valendo até expirar.
 */

/** Mesmo custo do login/cadastro/troca de senha (`api/routes/auth.routes.ts`). */
const BCRYPT_ROUNDS = 12
const LIMITE_POR_EMAIL_NA_JANELA = 3
const JANELA_POR_EMAIL_SEG = 60 * 60
const JANELA_GLOBAL_SEG = 60 * 60
/** Tentativas com token DESCONHECIDO/malformado por IP, numa janela (a 256 bits não há chute que funcione — isto barra o martelo e o ruído). */
export const LIMITE_TOKENS_INVALIDOS_POR_IP = 10
export const JANELA_TOKENS_INVALIDOS_SEG = 15 * 60
const PRAZO_REDIS_MS = 2_000

export interface ContaCompleta extends ContaParaRedefinicao {
  name: string
  email: string
  operatorId: string | null
}

export interface MetaDaRequisicao {
  ip: string | null
  userAgent: string | null
  requestId: string | null
}

export interface RepoDeContasParaRedefinicao {
  /** Busca por e-mail sem distinguir caixa (o cadastro já bloqueia duplicata sem caixa); ambíguo => `null`. */
  buscarPorEmail(email: string): Promise<ContaCompleta | null>
  buscarPorId(id: string): Promise<ContaCompleta | null>
  /**
   * Numa TRANSAÇÃO: troca `passwordHash`, `sessionsValidAfter = agora` (derruba todas as sessões, inclusive SSE) e grava a auditoria — só se a conta continua ativa e o hash
   * ainda é o esperado (outra troca de senha entre a leitura e a escrita => `false`, nada muda). Se a auditoria falhar, nada é trocado (lança).
   */
  trocarSenha(a: { id: string; hashEsperado: string | null; novoHash: string; agora: Date; auditoria: WriteAuditLogInput }): Promise<boolean>
  auditar(entrada: WriteAuditLogInput): Promise<void>
}

export interface LogDoServico {
  info(dados: Record<string, unknown>, mensagem: string): void
  warn(dados: Record<string, unknown>, mensagem: string): void
  error(dados: Record<string, unknown>, mensagem: string): void
}

export interface DepsDaRedefinicao {
  contas: RepoDeContasParaRedefinicao
  tokens: PortaDeTokensDeRedefinicao
  redis: Redis
  enviarEmail: (msg: { to: string; subject: string; text: string; html: string }) => Promise<ResultadoEmailTransacional>
  /** Origem pública do frontend (NUNCA da requisição). `null` = sem destino confiável. */
  baseUrl: () => string | null
  maxEmailsPorHora: number
  log: LogDoServico
  agora?: () => Date
}

export type ResultadoRedefinicao =
  | { status: 'OK'; userId: string; nome: string; email: string }
  | { status: 'TOKEN_INVALIDO' }
  | { status: 'BLOQUEADO'; retryAfterSeconds: number }
  | { status: 'INDISPONIVEL' }

const chaveEmail = (hash: string): string => `pwdreset:rl:email:${hash}`
const chaveGlobal = 'pwdreset:rl:global'
const chaveInvalidosDoIp = (ipHash: string): string => `pwdreset:bad:ip:${ipHash}`

export function criarServicoDeRedefinicao(deps: DepsDaRedefinicao) {
  const agora = deps.agora ?? ((): Date => new Date())
  const { log } = deps

  async function enviar(para: ContaCompleta, email: EmailPronto): Promise<ResultadoEmailTransacional> {
    return deps.enviarEmail({ to: para.email, subject: email.subject, text: email.text, html: email.html })
  }

  async function registrarTokenInvalido(ipHash: string): Promise<void> {
    try {
      await withDeadline(incrWithTtl(deps.redis, chaveInvalidosDoIp(ipHash), JANELA_TOKENS_INVALIDOS_SEG), PRAZO_REDIS_MS, 'contar token inválido')
    } catch {
      /* melhor esforço: o contador é defesa extra, o token de 256 bits já é a defesa */
    }
  }

  /** Consome 1 vaga do teto global de envios; `false` = teto estourado (não envia). */
  async function reservarEnvioGlobal(): Promise<boolean> {
    const total = await withDeadline(incrWithTtl(deps.redis, chaveGlobal, JANELA_GLOBAL_SEG), PRAZO_REDIS_MS, 'contar envio global')
    if (total > deps.maxEmailsPorHora) {
      log.error({ event: 'password_reset_global_cap_reached', teto: deps.maxEmailsPorHora }, '[auth] teto global de e-mails de redefinição por hora atingido — envio descartado (possível varredura de endereços)')
      return false
    }
    return true
  }

  return {
    /**
     * "Esqueci minha senha". Nunca lança. Só o que acontece em segundo plano — a resposta HTTP é a mesma 202 sempre.
     * `emailBruto` já vem validado/aparado pelo schema da rota.
     */
    async solicitar(emailBruto: string, meta: MetaDaRequisicao): Promise<void> {
      try {
        const contagem = await withDeadline(incrWithTtl(deps.redis, chaveEmail(hashDoEmail(emailBruto)), JANELA_POR_EMAIL_SEG), PRAZO_REDIS_MS, 'contar pedido por e-mail')
        if (contagem > LIMITE_POR_EMAIL_NA_JANELA) {
          log.info({ event: 'password_reset_throttled', escopo: 'email' }, '[auth] pedido de redefinição acima do limite por e-mail — ignorado em silêncio')
          return
        }

        const conta = await deps.contas.buscarPorEmail(emailBruto)
        const decisao = decidirSolicitacao(conta)

        if (decisao.acao === 'NADA') {
          if (decisao.motivo === 'ADMIN' && conta) {
            // ADMIN só redefine pelo script `user:set-password`: o pedido por e-mail não faz nada, mas fica registrado (tentativa de tomar a conta que controla o gateway).
            await deps.contas
              .auditar({
                actorUserId: conta.id,
                actorRole: 'ADMIN',
                actorEmail: conta.email,
                actorName: conta.name,
                actorOperatorId: conta.operatorId,
                action: 'PASSWORD_RESET',
                actionDetail: 'password_reset_denied_admin',
                outcome: 'DENIED',
                httpStatus: 202,
                entityType: 'User',
                entityId: conta.id,
                targetOperatorId: conta.operatorId,
                method: 'POST',
                path: '/api/auth/password/forgot',
                ipAddress: meta.ip,
                userAgent: meta.userAgent,
                requestId: meta.requestId,
              })
              .catch((err: unknown) => log.error({ err, userId: conta.id }, '[audit] falha ao gravar password_reset_denied_admin'))
            log.warn({ event: 'password_reset_admin_requested', userId: conta.id }, '[auth] pedido de redefinição por e-mail para conta ADMIN — recusado em silêncio (só pelo script)')
          }
          return
        }

        if (!conta) return // inalcançável (decisão NADA/INEXISTENTE já saiu); estreita o tipo

        if (decisao.acao === 'AVISO_GOOGLE') {
          if (!(await reservarEnvioGlobal())) return
          const r = await enviar(conta, emailDeAvisoGoogle({ nome: conta.name }))
          if (!r.ok) log.warn({ event: 'password_reset_email_failed', tipo: 'aviso_google', code: r.code, userId: conta.id }, '[auth] falha ao enviar o aviso "conta entra com o Google"')
          return
        }

        // ENVIAR_LINK
        const base = deps.baseUrl()
        if (!base) {
          log.error({ event: 'password_reset_base_url_missing', userId: conta.id }, '[auth] sem origem pública confiável (PUBLIC_APP_URL / CORS_ALLOWED_ORIGINS em produção) — e-mail de redefinição NÃO enviado')
          return
        }
        if (!(await reservarEnvioGlobal())) return

        const token = await withDeadline(deps.tokens.emitir(conta.id, impressaoDaSenha(conta.passwordHash)), PRAZO_REDIS_MS, 'emitir token')
        const link = montarLinkDeRedefinicao(base, token)
        const r = await enviar(conta, emailDeRedefinicao({ nome: conta.name, link, validadeMinutos: Math.round(TTL_TOKEN_REDEFINICAO_SEGUNDOS / 60) }))
        if (r.ok) log.info({ event: 'password_reset_email_sent', userId: conta.id }, '[auth] e-mail de redefinição de senha enviado')
        else log.warn({ event: 'password_reset_email_failed', tipo: 'link', code: r.code, userId: conta.id }, '[auth] falha ao enviar o e-mail de redefinição de senha')
      } catch (err) {
        // `err` pode vir do Prisma/Redis — o serializer do logger mascara o que importa; NUNCA o e-mail/token (não estão em escopo aqui além do que já foi tratado).
        log.error({ err, event: 'password_reset_request_failed' }, '[auth] falha ao processar o pedido de redefinição de senha')
      }
    },

    /** O clique no link. Lança só para erro NOSSO inesperado (banco/auditoria); os desfechos esperados são `ResultadoRedefinicao`. */
    async redefinir(entrada: { token: string; novaSenha: string }, meta: MetaDaRequisicao): Promise<ResultadoRedefinicao> {
      const ipHash = hashDoIp(meta.ip ?? 'desconhecido')

      try {
        const invalidos = Number((await withDeadline(deps.redis.get(chaveInvalidosDoIp(ipHash)), PRAZO_REDIS_MS, 'ler tokens inválidos do IP')) ?? 0)
        if (invalidos >= LIMITE_TOKENS_INVALIDOS_POR_IP) {
          const ttl = await withDeadline(deps.redis.ttl(chaveInvalidosDoIp(ipHash)), PRAZO_REDIS_MS, 'ttl tokens inválidos do IP')
          return { status: 'BLOQUEADO', retryAfterSeconds: ttl > 0 ? ttl : JANELA_TOKENS_INVALIDOS_SEG }
        }
      } catch (err) {
        log.error({ err, event: 'password_reset_redis_unavailable' }, '[auth] Redis indisponível ao redefinir senha')
        return { status: 'INDISPONIVEL' }
      }

      if (!formatoDeTokenValido(entrada.token)) {
        await registrarTokenInvalido(ipHash)
        return { status: 'TOKEN_INVALIDO' }
      }

      let valor: Awaited<ReturnType<PortaDeTokensDeRedefinicao['consumir']>>
      try {
        valor = await withDeadline(deps.tokens.consumir(entrada.token), PRAZO_REDIS_MS, 'consumir token')
      } catch (err) {
        log.error({ err, event: 'password_reset_redis_unavailable' }, '[auth] Redis indisponível ao consumir o token de redefinição')
        return { status: 'INDISPONIVEL' }
      }
      if (!valor) {
        await registrarTokenInvalido(ipHash)
        return { status: 'TOKEN_INVALIDO' }
      }

      // Daqui em diante o token JÁ foi consumido: erro NOSSO devolve o token (melhor esforço) antes de propagar.
      const devolver = async (): Promise<void> => {
        try {
          await withDeadline(deps.tokens.devolver(entrada.token, valor), PRAZO_REDIS_MS, 'devolver token')
        } catch {
          /* o usuário pede outro link */
        }
      }

      try {
        const conta = await deps.contas.buscarPorId(valor.userId)
        if (!conta || !contaPodeConsumirToken(conta, valor.impressao)) {
          log.info({ event: 'password_reset_token_refused', userId: valor.userId }, '[auth] token de redefinição consumido, mas a conta não pode mais redefinir (inativa/ADMIN/senha mudou)')
          return { status: 'TOKEN_INVALIDO' }
        }

        const novoHash = await bcrypt.hash(entrada.novaSenha, BCRYPT_ROUNDS)
        const quando = agora()
        const trocou = await deps.contas.trocarSenha({
          id: conta.id,
          hashEsperado: conta.passwordHash,
          novoHash,
          agora: quando,
          auditoria: {
            actorUserId: conta.id,
            actorRole: conta.role,
            actorEmail: conta.email,
            actorName: conta.name,
            actorOperatorId: conta.operatorId,
            action: 'PASSWORD_RESET',
            actionDetail: 'password_reset_by_email', // nunca o token nem a senha
            outcome: 'SUCCESS',
            httpStatus: 204,
            entityType: 'User',
            entityId: conta.id,
            targetOperatorId: conta.operatorId,
            method: 'POST',
            path: '/api/auth/password/reset',
            ipAddress: meta.ip,
            userAgent: meta.userAgent,
            requestId: meta.requestId,
          },
        })
        if (!trocou) return { status: 'TOKEN_INVALIDO' } // a senha/ativação mudou entre a leitura e a escrita: nada foi alterado

        log.info({ event: 'password_reset_done', userId: conta.id }, '[auth] senha redefinida por e-mail; sessões revogadas')
        return { status: 'OK', userId: conta.id, nome: conta.name, email: conta.email }
      } catch (err) {
        await devolver()
        throw err
      }
    },

    /** E-mail "sua senha foi alterada" (segurança: sempre ligado — DL5). Nunca lança. Reaproveitável pela troca autenticada (L1.2). */
    async avisarSenhaAlterada(conta: { nome: string; email: string }): Promise<void> {
      try {
        const base = deps.baseUrl()
        const pronto = emailDeSenhaAlterada({ nome: conta.nome, quando: formatarQuando(agora()), linkEsqueciSenha: base ? `${base}/esqueci-senha` : null })
        const r = await deps.enviarEmail({ to: conta.email, subject: pronto.subject, text: pronto.text, html: pronto.html })
        if (!r.ok) log.warn({ event: 'password_changed_email_failed', code: r.code }, '[auth] falha ao enviar o aviso "senha alterada"')
      } catch (err) {
        log.error({ err, event: 'password_changed_email_failed' }, '[auth] falha ao enviar o aviso "senha alterada"')
      }
    },
  }
}

export type ServicoDeRedefinicao = ReturnType<typeof criarServicoDeRedefinicao>
