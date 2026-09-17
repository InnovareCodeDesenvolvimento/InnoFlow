import { logger } from '../../lib/logger'
import { authorizeReqSchema } from '../schemas/authorize'
import { checkAuthorization } from '../authorizationCheck'
import { defineOcppHandler } from './defineHandler'

/**
 * F4 (2026-09-17): além do `AuthToken.status`, agora também bloqueia por
 * `Debt` aberta e saldo de carteira abaixo do mínimo — regra centralizada em
 * `avaliarInicioSessao` (núcleo puro), reaproveitada aqui via
 * `checkAuthorization`. NÃO reserva/debita nada aqui (carteira pré-paga sem
 * hold — decisão da Nova, ver PROGRESSO.md §F4 desenhada); débito real só
 * acontece no `StopTransaction`.
 */
export const handleAuthorize = defineOcppHandler('Authorize', authorizeReqSchema, async (data, ctx) => {
  const { resultado } = await checkAuthorization(data.idTag)

  if (resultado.decision !== 'Accepted') {
    logger.warn(
      { idTag: data.idTag, chargePointId: ctx.chargePointId, decision: resultado.decision, reason: resultado.reason },
      '[ocpp] Authorize recusado',
    )
  }

  return { idTagInfo: { status: resultado.decision } }
})
