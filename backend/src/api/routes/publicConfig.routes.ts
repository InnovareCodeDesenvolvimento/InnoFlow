import { Router } from 'express'
import { env } from '../../lib/env'

/**
 * `GET /api/public/config` — configuração PÚBLICA que o cliente precisa para
 * montar a tela de login (contrato: `PublicClientConfig` em
 * `frontend/src/types/api.ts`). Sem auth, atrás de `publicRateLimit`.
 *
 * `googleClientId` é público por desenho do Google (o front precisa dele para
 * renderizar o botão) e mora na env do BACKEND, não no build do frontend —
 * assim dá pra ligar/desligar o login com Google sem rebuild. `null` = não
 * configurado: o botão simplesmente não é renderizado. NUNCA colocar segredo
 * aqui — só valores que já são públicos.
 */
const router = Router()

router.get('/', (_req, res) => {
  res.json({ googleClientId: env.GOOGLE_CLIENT_ID ?? null })
})

export default router
