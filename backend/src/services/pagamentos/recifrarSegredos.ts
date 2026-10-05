import type { PrismaClient } from '@prisma/client'
import { SYSTEM_ACTOR } from '../../core/auditoria/systemActor'
import { MARCADOR_TOKEN_CARTAO_DESTRUIDO } from '../../core/lgpd/exclusaoDeConta'
import { ciphertextEstaNaChaveAtual, decryptPaymentSecret, encryptPaymentSecret, isPaymentSecretsKeyConfigured } from '../../lib/crypto/paymentSecrets'
import { writeAuditLog } from '../auditoria/writeAuditLog'

/**
 * Re-cifra os segredos de pagamento com a chave-mestra ATUAL — o miolo da ROTAÇÃO de chave (F5.7). Desde 05/10/2026 a chave atual é a DERIVADA do `JWT_SECRET` (padrão, como no InnoChat) ou o override `PAYMENT_SECRETS_KEY`; o script serve para MIGRAR entre as duas (derivada => override, ou override => derivada com o override em `PAYMENT_SECRETS_KEY_PREVIOUS`) e para a rotação do override. Ele NÃO recupera segredo cifrado com um JWT_SECRET que já foi trocado e perdido: esses são ilegíveis e precisam ser recadastrados. Usado SÓ pelo script administrativo
 * `backend/scripts/recifrarSegredosDePagamento.ts` (fora do HTTP: ninguém aciona isto por rota). Runbook em `docs/DEPLOY-EASYPANEL.md`.
 *
 * Alvos: `PaymentMethod.cieloCardTokenCiphertext` (todas as linhas, ativas ou não — exceto as de conta excluída, com o marcador `DESTROYED`), `AccountDeletionRequest.refundPixKeyCiphertext` (chave Pix de devolução, L1.4), as três colunas `*Ciphertext` de `PaymentGatewayConfig` e as duas de `NotificationChannelConfig`
 * (senha SMTP e apikey da Evolution — N-7: a MESMA chave cifra os segredos de comunicação; sem isto a rotação deixaria esses dois para trás, ilegíveis) e as cinco de `BackupConfig` (S3, Google e a cópia
 * cifrada da chave do backup).
 *
 * Regras:
 *  - DRY-RUN por padrão (`apply: false` não grava NADA, só conta); `apply: true` grava.
 *  - IDEMPOTENTE: o que já está em `v1:<kid atual>:...` E DECIFRA é pulado — rodar de novo não muda nada. `v1` da chave atual que não decifra é ilegível, não "já na atual".
 *  - Decifra com `decryptPaymentSecret` (atual, `PAYMENT_SECRETS_KEY_PREVIOUS` ou — com override ativo — a derivada do JWT_SECRET; `v1` ou legado) e regrava com `encryptPaymentSecret` (sempre `v1` + chave atual).
 *    O que NÃO decifra com nenhuma das chaves é CONTADO como ilegível e deixado como está (nunca apagado) — a rotação só pode ser dada como concluída com ilegíveis = 0.
 *  - Compare-and-set por linha: a regravação só vale se a coluna ainda tem o ciphertext lido (uma gravação concorrente da API não é pisada).
 *  - NUNCA devolve/imprime segredo nem ciphertext: o relatório tem só contagens (e ids de cartões ilegíveis, que não são segredo).
 *  - Em `apply`, se algo foi regravado, UMA linha de auditoria (ator SYSTEM) com as contagens.
 */

export type AlvoRecifragem = 'PaymentMethod.cieloCardTokenCiphertext' | 'PaymentGatewayConfig.merchantKeyCiphertext' | 'PaymentGatewayConfig.sopClientSecretCiphertext' | 'PaymentGatewayConfig.webhookHeaderSecretCiphertext'
  | 'NotificationChannelConfig.smtpPasswordCiphertext'
  | 'NotificationChannelConfig.evolutionApiKeyCiphertext'
  | 'BackupConfig.s3AccessKeyCiphertext'
  | 'BackupConfig.s3SecretKeyCiphertext'
  | 'BackupConfig.driveOauthClientSecretCiphertext'
  | 'BackupConfig.driveOauthRefreshTokenCiphertext'
  | 'BackupConfig.encryptionKeyCiphertext'
  | 'AccountDeletionRequest.refundPixKeyCiphertext'

export interface RelatorioAlvo {
  alvo: AlvoRecifragem
  /** Valores não nulos examinados. */
  total: number
  /** Já em `v1` com a chave atual — nada a fazer. */
  jaNaChaveAtual: number
  /** Decifram e precisam ser regravados (dry-run: seriam; apply: foram, salvo `alteradosDuranteExecucao`). */
  aRecifrar: number
  /** Gravados de fato neste run (sempre 0 em dry-run). */
  recifrados: number
  /** Não decifram com nenhuma chave configurada — ficaram como estavam. */
  ilegiveis: number
  /** O valor mudou entre a leitura e a gravação (corrida com a API): pulado, rode de novo. */
  alteradosDuranteExecucao: number
  /** Só para `PaymentMethod` (ids não são segredo): até 20 cartões ilegíveis. */
  idsIlegiveis: string[]
}

export interface RelatorioRecifragem {
  apply: boolean
  alvos: RelatorioAlvo[]
  totais: { total: number; jaNaChaveAtual: number; aRecifrar: number; recifrados: number; ilegiveis: number; alteradosDuranteExecucao: number }
}

const PAGINA = 200
const MAX_IDS_ILEGIVEIS = 20

export class ChaveDePagamentoNaoConfiguradaError extends Error {
  constructor() {
    super('Chave-mestra dos segredos indisponível neste ambiente (JWT_SECRET ausente/curto, ou PAYMENT_SECRETS_KEY definida e inválida) — sem a chave atual não há como re-cifrar nada.')
    this.name = 'ChaveDePagamentoNaoConfiguradaError'
  }
}

function novoAlvo(alvo: AlvoRecifragem): RelatorioAlvo {
  return { alvo, total: 0, jaNaChaveAtual: 0, aRecifrar: 0, recifrados: 0, ilegiveis: 0, alteradosDuranteExecucao: 0, idsIlegiveis: [] }
}

/** Classifica UM valor. `novo` só vem preenchido quando precisa regravar. Nunca lança nem expõe o texto. */
function avaliar(ciphertext: string): { situacao: 'JA_NA_ATUAL' | 'A_RECIFRAR' | 'ILEGIVEL'; novo?: string } {
  try {
    // "Já na chave atual" só vale se DECIFRA: o prefixo `v1:<kid atual>:` sozinho não prova nada — um corpo corrompido/truncado com o kid certo contava como
    // "ok" e o relatório dizia "Concluído / ilegíveis: 0" (achado da Íris, F5.8). Custa 1 AES-GCM por valor; o texto decifrado é descartado na hora.
    if (ciphertextEstaNaChaveAtual(ciphertext)) {
      decryptPaymentSecret(ciphertext)
      return { situacao: 'JA_NA_ATUAL' }
    }
  } catch {
    return { situacao: 'ILEGIVEL' } // formato desconhecido/mal formado, ou `v1` da chave atual que não decifra (corpo corrompido)
  }
  try {
    return { situacao: 'A_RECIFRAR', novo: encryptPaymentSecret(decryptPaymentSecret(ciphertext)) }
  } catch {
    return { situacao: 'ILEGIVEL' }
  }
}

export async function recifrarSegredosDePagamento(params: { apply: boolean; prisma: PrismaClient }): Promise<RelatorioRecifragem> {
  const { apply, prisma } = params
  if (!isPaymentSecretsKeyConfigured()) throw new ChaveDePagamentoNaoConfiguradaError()

  const alvos: RelatorioAlvo[] = []

  // --- PaymentMethod (paginado por id: nunca carrega a tabela inteira) ---------------------------
  const cartoes = novoAlvo('PaymentMethod.cieloCardTokenCiphertext')
  alvos.push(cartoes)
  let cursor: string | undefined
  for (;;) {
    const lote = await prisma.paymentMethod.findMany({
      select: { id: true, cieloCardTokenCiphertext: true },
      orderBy: { id: 'asc' },
      take: PAGINA,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    })
    if (lote.length === 0) break
    for (const linha of lote) {
      // Cartão de conta EXCLUÍDA (L1.4): o token foi destruído de propósito (marcador literal, não é ciphertext). Não é segredo a re-cifrar nem "ilegível" — pular sem contar,
      // senão a rotação nunca chegaria a "ilegíveis: 0" depois da primeira exclusão de conta.
      if (linha.cieloCardTokenCiphertext === MARCADOR_TOKEN_CARTAO_DESTRUIDO) continue
      cartoes.total += 1
      const r = avaliar(linha.cieloCardTokenCiphertext)
      if (r.situacao === 'JA_NA_ATUAL') cartoes.jaNaChaveAtual += 1
      else if (r.situacao === 'ILEGIVEL') {
        cartoes.ilegiveis += 1
        if (cartoes.idsIlegiveis.length < MAX_IDS_ILEGIVEIS) cartoes.idsIlegiveis.push(linha.id)
      } else {
        cartoes.aRecifrar += 1
        if (apply) {
          const { count } = await prisma.paymentMethod.updateMany({ where: { id: linha.id, cieloCardTokenCiphertext: linha.cieloCardTokenCiphertext }, data: { cieloCardTokenCiphertext: r.novo! } })
          if (count === 1) cartoes.recifrados += 1
          else cartoes.alteradosDuranteExecucao += 1
        }
      }
    }
    cursor = lote[lote.length - 1]!.id
    if (lote.length < PAGINA) break
  }

  // --- PaymentGatewayConfig (singleton id=1) ---------------------------------------------------
  const config = await prisma.paymentGatewayConfig.findUnique({ where: { id: 1 } })
  const colunas = ['merchantKeyCiphertext', 'sopClientSecretCiphertext', 'webhookHeaderSecretCiphertext'] as const
  for (const coluna of colunas) {
    const alvo = novoAlvo(`PaymentGatewayConfig.${coluna}`)
    alvos.push(alvo)
    const valor = config?.[coluna]
    if (!config || !valor) continue
    alvo.total += 1
    const r = avaliar(valor)
    if (r.situacao === 'JA_NA_ATUAL') alvo.jaNaChaveAtual += 1
    else if (r.situacao === 'ILEGIVEL') alvo.ilegiveis += 1
    else {
      alvo.aRecifrar += 1
      if (apply) {
        // `updatedAt` explícito = o MESMO valor: re-cifrar não é uma "alteração de configuração" (a tela e o cache da API não devem ver isto como mudança do admin).
        const { count } = await prisma.paymentGatewayConfig.updateMany({ where: { id: 1, [coluna]: valor }, data: { [coluna]: r.novo!, updatedAt: config.updatedAt } })
        if (count === 1) alvo.recifrados += 1
        else alvo.alteradosDuranteExecucao += 1
      }
    }
  }

  // --- NotificationChannelConfig (singleton id=1): senha SMTP e apikey da Evolution — cifradas com a MESMA chave (N-7) ---------------------------------------------
  const comunicacao = await prisma.notificationChannelConfig.findUnique({ where: { id: 1 } })
  const colunasComunicacao = ['smtpPasswordCiphertext', 'evolutionApiKeyCiphertext'] as const
  for (const coluna of colunasComunicacao) {
    const alvo = novoAlvo(`NotificationChannelConfig.${coluna}`)
    alvos.push(alvo)
    const valor = comunicacao?.[coluna]
    if (!comunicacao || !valor) continue
    alvo.total += 1
    const r = avaliar(valor)
    if (r.situacao === 'JA_NA_ATUAL') alvo.jaNaChaveAtual += 1
    else if (r.situacao === 'ILEGIVEL') alvo.ilegiveis += 1
    else {
      alvo.aRecifrar += 1
      if (apply) {
        // `updatedAt` explícito = o MESMO valor: re-cifrar não é uma alteração de configuração.
        const { count } = await prisma.notificationChannelConfig.updateMany({ where: { id: 1, [coluna]: valor }, data: { [coluna]: r.novo!, updatedAt: comunicacao.updatedAt } })
        if (count === 1) alvo.recifrados += 1
        else alvo.alteradosDuranteExecucao += 1
      }
    }
  }

  // --- BackupConfig (singleton id=1): credenciais do S3, segredo/refresh token do Google e a CÓPIA CIFRADA da chave do backup — cifradas com a MESMA chave. Sem isto a rotação deixaria o agendador
  // sem poder cifrar/enviar o backup de madrugada (e a cópia da chave do backup ilegível). -------------------------------------------------------------------------------------------------
  const backup = await prisma.backupConfig.findUnique({ where: { id: 1 } })
  const colunasBackup = ['s3AccessKeyCiphertext', 's3SecretKeyCiphertext', 'driveOauthClientSecretCiphertext', 'driveOauthRefreshTokenCiphertext', 'encryptionKeyCiphertext'] as const
  for (const coluna of colunasBackup) {
    const alvo = novoAlvo(`BackupConfig.${coluna}`)
    alvos.push(alvo)
    const valor = backup?.[coluna]
    if (!backup || !valor) continue
    alvo.total += 1
    const r = avaliar(valor)
    if (r.situacao === 'JA_NA_ATUAL') alvo.jaNaChaveAtual += 1
    else if (r.situacao === 'ILEGIVEL') alvo.ilegiveis += 1
    else {
      alvo.aRecifrar += 1
      if (apply) {
        // `updatedAt` explícito = o MESMO valor: re-cifrar não é uma alteração de configuração.
        const { count } = await prisma.backupConfig.updateMany({ where: { id: 1, [coluna]: valor }, data: { [coluna]: r.novo!, updatedAt: backup.updatedAt } })
        if (count === 1) alvo.recifrados += 1
        else alvo.alteradosDuranteExecucao += 1
      }
    }
  }

  // --- AccountDeletionRequest.refundPixKeyCiphertext (L1.4): a chave Pix de devolução, cifrada com a MESMA chave. Só pedidos PENDING_REFUND têm valor (é apagada ao devolver); paginado por id. ---
  const chavesPix = novoAlvo('AccountDeletionRequest.refundPixKeyCiphertext')
  alvos.push(chavesPix)
  let cursorPix: string | undefined
  for (;;) {
    const lote = await prisma.accountDeletionRequest.findMany({
      where: { refundPixKeyCiphertext: { not: null } },
      select: { id: true, refundPixKeyCiphertext: true },
      orderBy: { id: 'asc' },
      take: PAGINA,
      ...(cursorPix ? { cursor: { id: cursorPix }, skip: 1 } : {}),
    })
    if (lote.length === 0) break
    for (const linha of lote) {
      const valor = linha.refundPixKeyCiphertext
      if (!valor) continue
      chavesPix.total += 1
      const r = avaliar(valor)
      if (r.situacao === 'JA_NA_ATUAL') chavesPix.jaNaChaveAtual += 1
      else if (r.situacao === 'ILEGIVEL') chavesPix.ilegiveis += 1
      else {
        chavesPix.aRecifrar += 1
        if (apply) {
          const { count } = await prisma.accountDeletionRequest.updateMany({ where: { id: linha.id, refundPixKeyCiphertext: valor }, data: { refundPixKeyCiphertext: r.novo! } })
          if (count === 1) chavesPix.recifrados += 1
          else chavesPix.alteradosDuranteExecucao += 1
        }
      }
    }
    cursorPix = lote[lote.length - 1]!.id
    if (lote.length < PAGINA) break
  }

  const totais = alvos.reduce(
    (t, a) => ({
      total: t.total + a.total,
      jaNaChaveAtual: t.jaNaChaveAtual + a.jaNaChaveAtual,
      aRecifrar: t.aRecifrar + a.aRecifrar,
      recifrados: t.recifrados + a.recifrados,
      ilegiveis: t.ilegiveis + a.ilegiveis,
      alteradosDuranteExecucao: t.alteradosDuranteExecucao + a.alteradosDuranteExecucao,
    }),
    { total: 0, jaNaChaveAtual: 0, aRecifrar: 0, recifrados: 0, ilegiveis: 0, alteradosDuranteExecucao: 0 },
  )

  if (apply && totais.recifrados > 0) {
    await writeAuditLog({
      actorUserId: SYSTEM_ACTOR.userId,
      actorRole: 'SYSTEM',
      actorEmail: SYSTEM_ACTOR.email,
      actorName: 'Rotação de chave (script administrativo)',
      actorOperatorId: null,
      action: 'PAYMENT_CONFIG_CHANGE',
      actionDetail: 'secrets_reencrypted',
      outcome: 'SUCCESS',
      entityType: 'PaymentGatewayConfig',
      entityId: '1',
      // SÓ contagens — nunca segredo nem ciphertext.
      changes: Object.fromEntries(alvos.filter((a) => a.recifrados > 0).map((a) => [a.alvo, { changed: true, count: a.recifrados }])),
    })
  }

  return { apply, alvos, totais }
}

/** Texto do relatório para o terminal — só contagens. */
export function formatarRelatorio(r: RelatorioRecifragem): string {
  const linhas = [`Re-cifragem dos segredos de pagamento — ${r.apply ? 'APLICANDO (--apply)' : 'DRY-RUN (nada foi gravado; use --apply para gravar)'}`]
  for (const a of r.alvos) {
    linhas.push(
      `  ${a.alvo}: ${a.total} valor(es) — já na chave atual: ${a.jaNaChaveAtual}, ${r.apply ? `re-cifrados: ${a.recifrados}` : `a re-cifrar: ${a.aRecifrar}`}, ilegíveis: ${a.ilegiveis}` +
        (a.alteradosDuranteExecucao > 0 ? `, alterados durante a execução (rode de novo): ${a.alteradosDuranteExecucao}` : ''),
    )
    if (a.idsIlegiveis.length > 0) linhas.push(`    ids dos ilegíveis (até ${MAX_IDS_ILEGIVEIS}): ${a.idsIlegiveis.join(', ')}`)
  }
  linhas.push(`  TOTAL: ${r.totais.total} — já na chave atual: ${r.totais.jaNaChaveAtual}, ${r.apply ? `re-cifrados: ${r.totais.recifrados}` : `a re-cifrar: ${r.totais.aRecifrar}`}, ilegíveis: ${r.totais.ilegiveis}`)
  if (r.totais.ilegiveis > 0) {
    linhas.push('  ATENÇÃO: há valores que NENHUMA chave configurada decifra (chave atual, PAYMENT_SECRETS_KEY_PREVIOUS e, com override, a derivada do JWT_SECRET). NÃO remova a chave anterior ainda.')
    linhas.push('  Se a chave que os cifrou foi PERDIDA (ex.: o JWT_SECRET foi trocado e o valor antigo não existe mais), esses valores são irrecuperáveis: cartões salvos precisam ser cadastrados de novo pelos motoristas e os segredos do gateway/comunicação/backup reenviados pela tela do admin. Se você ainda tem o JWT_SECRET antigo, volte a ele e tudo decifra.')
  } else if (r.apply && r.totais.alteradosDuranteExecucao === 0) {
    linhas.push('  Concluído: tudo está na chave atual. Já pode remover PAYMENT_SECRETS_KEY_PREVIOUS e reiniciar.')
  } else if (!r.apply && r.totais.aRecifrar === 0) {
    linhas.push('  Nada a re-cifrar: tudo já está na chave atual.')
  }
  return linhas.join('\n')
}
