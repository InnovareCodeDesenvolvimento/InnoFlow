import { prisma } from '../../lib/prisma'
import { env } from '../../lib/env'
import { logger } from '../../lib/logger'
import { AppError } from '../../api/middleware/errorHandler'
import { resolverDadosLegais, type DadosLegaisEfetivos, type LinhaPerfilEmpresa } from '../../core/legal/dadosLegais'

/**
 * Dados legais EFETIVOS (versões dos Termos/Privacidade + dados da empresa): o painel (`CompanyProfile`) manda, as envs `LEGAL_*` são a reserva. Regras de resolução em
 * `core/legal/dadosLegais.ts`; aqui só o banco e o cache.
 *
 * CACHE: guarda só a LINHA do banco (nunca o resultado resolvido): a env é lida a cada chamada, então mudar a env (ou os testes que mexem em `env`) vale na hora; o que custa é o banco.
 * TTL de 30 s por processo. Quem GRAVA (a API) invalida o próprio cache na hora; o worker e as outras réplicas da API enxergam a mudança em até 30 s. Isso é aceitável porque
 * uma réplica atrasada só pode recusar um aceite com `TERMS_VERSION_OUTDATED` (409) — o front recarrega `GET /api/public/legal` e tenta de novo — nunca gravar um aceite errado.
 *
 * FALHA DO BANCO, dois comportamentos de propósito:
 *  - `getDadosLegais()` (página pública, rodapé dos e-mails): NUNCA lança — cai na env (reserva) por 5 s e avisa. Rodapé de e-mail não pode parar por isso.
 *  - `getDadosLegaisEstrito()` (aceite de termos, tela do admin): lança 503. Gravar um aceite contra a versão da ENV enquanto o banco manda outra deixaria o motorista "fora de dia"
 *    sem ele ter feito nada; é melhor falhar alto e deixar tentar de novo.
 */

export const CACHE_DADOS_LEGAIS_TTL_MS = 30_000
const CACHE_FALHA_MS = 5_000

const SELECT_LINHA = {
  legalName: true,
  tradeName: true,
  cnpj: true,
  supportEmail: true,
  supportPhone: true,
  address: true,
  website: true,
  dpoName: true,
  dpoEmail: true,
  termsVersion: true,
  privacyVersion: true,
  companyDataSavedAt: true,
  updatedByUserId: true,
  updatedAt: true,
} as const

interface EntradaCache {
  linha: LinhaPerfilEmpresa | null
  leituraFalhou: boolean
  validoAte: number
}

let cache: EntradaCache | null = null
let carregando: Promise<EntradaCache> | null = null
/** Incrementa a cada invalidação: uma leitura iniciada ANTES de uma gravação não pode repovoar o cache com dado velho. */
let geracao = 0
let avisouCamposInvalidos = false
let ultimoAvisoDeFalha = 0

export class DadosLegaisIndisponiveisError extends AppError {
  constructor() {
    super('Não foi possível ler os dados legais agora. Tente novamente em instantes.', 503, 'LEGAL_SETTINGS_UNAVAILABLE')
    this.name = 'DadosLegaisIndisponiveisError'
  }
}

async function lerLinha(): Promise<EntradaCache> {
  try {
    const row = await prisma.companyProfile.findUnique({ where: { id: 1 }, select: SELECT_LINHA })
    return { linha: row, leituraFalhou: false, validoAte: Date.now() + CACHE_DADOS_LEGAIS_TTL_MS }
  } catch (err) {
    const t = Date.now()
    if (t - ultimoAvisoDeFalha > 60_000) {
      ultimoAvisoDeFalha = t
      // SEM o campo `alert` (não gera aviso ao dono em laço) e sem a mensagem do erro (pode carregar trecho de SQL).
      logger.warn({ erro: err instanceof Error ? err.name : 'erro' }, '[legal] falha ao ler CompanyProfile — usando só as envs LEGAL_* (reserva) até o banco voltar')
    }
    return { linha: null, leituraFalhou: true, validoAte: t + CACHE_FALHA_MS }
  }
}

async function carregar(estrito: boolean): Promise<EntradaCache> {
  const agora = Date.now()
  if (cache && cache.validoAte > agora && !(estrito && cache.leituraFalhou)) return cache
  if (carregando) {
    const emAndamento = await carregando
    if (!(estrito && emAndamento.leituraFalhou)) return emAndamento
  }
  const geracaoNoInicio = geracao
  const promessa = lerLinha().finally(() => {
    if (carregando === promessa) carregando = null
  })
  carregando = promessa
  const entrada = await promessa
  if (geracao === geracaoNoInicio) cache = entrada
  return entrada
}

function resolver(entrada: EntradaCache): DadosLegaisEfetivos {
  const r = resolverDadosLegais(entrada.linha, env)
  if (r.camposInvalidosDaEnv.length > 0 && !avisouCamposInvalidos) {
    avisouCamposInvalidos = true
    logger.warn({ campos: r.camposInvalidosDaEnv }, '[legal] variável LEGAL_* com valor inválido — o campo sai vazio em /api/public/legal até ser corrigida')
  }
  return r
}

/** Versões, dados da empresa e de onde vêm. NUNCA lança (banco fora => env). */
export async function getDadosLegais(): Promise<DadosLegaisEfetivos> {
  return resolver(await carregar(false))
}

/** Igual a `getDadosLegais`, mas banco fora => 503 `LEGAL_SETTINGS_UNAVAILABLE`. */
export async function getDadosLegaisEstrito(): Promise<DadosLegaisEfetivos> {
  const entrada = await carregar(true)
  if (entrada.leituraFalhou) throw new DadosLegaisIndisponiveisError()
  return resolver(entrada)
}

/** A linha CRUA do banco (para a tela do admin mostrar quem/quando salvou). Estrita. */
export async function getLinhaDoPerfilEstrita(): Promise<LinhaPerfilEmpresa | null> {
  const entrada = await carregar(true)
  if (entrada.leituraFalhou) throw new DadosLegaisIndisponiveisError()
  return entrada.linha
}

/** Invalida o cache DESTE processo (logo depois de gravar). Outros processos expiram pelo TTL. */
export function invalidarCacheDadosLegais(): void {
  geracao += 1
  cache = null
  carregando = null
}

/** Só para teste. */
export function resetDadosLegaisParaTeste(): void {
  invalidarCacheDadosLegais()
  avisouCamposInvalidos = false
  ultimoAvisoDeFalha = 0
}

export { SELECT_LINHA as SELECT_LINHA_PERFIL_EMPRESA }
