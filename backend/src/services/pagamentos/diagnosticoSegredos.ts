import type { PrismaClient } from '@prisma/client'
import { logger } from '../../lib/logger'
import { modoDaChaveMestra } from '../../lib/crypto/paymentSecrets'
import { recifrarSegredosDePagamento, type RelatorioRecifragem } from './recifrarSegredos'

/**
 * DIAGNÓSTICO DE SEGREDOS ILEGÍVEIS (decisão do dono, 05/10/2026: a chave dos segredos é derivada do `JWT_SECRET`, como no InnoChat).
 *
 * Trocar o `JWT_SECRET` não derruba o boot: os segredos já salvos simplesmente deixam de decifrar (fail-closed — viram "ausentes"). Cada consumidor trata isso do seu jeito (gateway fica
 * indisponível, backup falha com `SECRETS_KEY`/`KEY`, cartão responde 409 `PAYMENT_METHOD_UNREADABLE`), mas NINGUÉM dizia ao dono, num lugar só, "você trocou o JWT_SECRET: isto está ilegível".
 * Este diagnóstico olha TODOS os lugares que guardam segredo cifrado (reaproveita o DRY-RUN da re-cifragem: nada é gravado) e, se algo não decifra, emite UM alerta `secrets_undecryptable`
 * (CRITICO) com as contagens por área e a orientação. Roda no boot do worker. NUNCA lança (não pode derrubar o boot), nunca loga valor/ciphertext — só contagens.
 */

export interface ResultadoDoDiagnostico {
  /** `false` = não deu para diagnosticar (chave-mestra indisponível ou banco fora). */
  executado: boolean
  ilegiveis: number
  /** Só as áreas com ilegíveis: `alvo => quantidade`. */
  porAlvo: Record<string, number>
}

/** Agrupa os alvos com ilegíveis em áreas que o dono reconhece (não nomes de coluna). */
function areaDoAlvo(alvo: string): string {
  if (alvo.startsWith('PaymentMethod.')) return 'cartoes_dos_motoristas'
  if (alvo.startsWith('PaymentGatewayConfig.')) return 'gateway_cielo'
  if (alvo.startsWith('NotificationChannelConfig.')) return 'comunicacao_email_whatsapp'
  if (alvo.startsWith('BackupConfig.')) return 'backup'
  if (alvo.startsWith('AccountDeletionRequest.')) return 'devolucao_de_saldo_chave_pix'
  return alvo
}

export function resumirIlegiveis(relatorio: RelatorioRecifragem): { ilegiveis: number; porArea: Record<string, number> } {
  const porArea: Record<string, number> = {}
  for (const a of relatorio.alvos) {
    if (a.ilegiveis > 0) porArea[areaDoAlvo(a.alvo)] = (porArea[areaDoAlvo(a.alvo)] ?? 0) + a.ilegiveis
  }
  return { ilegiveis: relatorio.totais.ilegiveis, porArea }
}

export async function verificarSegredosSalvos(prisma: PrismaClient): Promise<ResultadoDoDiagnostico> {
  try {
    const relatorio = await recifrarSegredosDePagamento({ apply: false, prisma })
    const { ilegiveis, porArea } = resumirIlegiveis(relatorio)
    if (ilegiveis > 0) {
      logger.error(
        { alert: 'secrets_undecryptable', modoDaChave: modoDaChaveMestra(), ilegiveis, porArea },
        '[segredos] há segredos salvos que o servidor NÃO consegue decifrar — o JWT_SECRET (de onde deriva a chave dos segredos) mudou, ou o PAYMENT_SECRETS_KEY (override) mudou. Volte ao valor antigo ou recadastre: gateway, e-mail/WhatsApp e backup em Admin > Configurações; os motoristas precisam cadastrar o cartão de novo.',
      )
    }
    return { executado: true, ilegiveis, porAlvo: porArea }
  } catch (err) {
    // Sem a chave-mestra, ou banco fora: não derruba o boot. Só o nome do erro (nunca um objeto que possa carregar valor de coluna).
    logger.warn({ motivo: err instanceof Error ? err.name : 'erro' }, '[segredos] não consegui verificar se os segredos salvos decifram (chave-mestra indisponível ou banco fora)')
    return { executado: false, ilegiveis: 0, porAlvo: {} }
  }
}
