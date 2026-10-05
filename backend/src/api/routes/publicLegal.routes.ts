import { Router } from 'express'
import { dadosPublicosDaEmpresa, versoesVigentes } from '../../services/legal/consentimento'

/**
 * `GET /api/public/legal` — termos de uso/privacidade: versão VIGENTE e dados públicos da empresa (controlador, suporte, encarregado/DPO). Sem auth, atrás de `publicRateLimit`.
 * Contrato: `PublicLegalConfig` em `frontend/src/types/api.ts`. Tudo vem de env (`LEGAL_*`, ver `.env.example`); o que o dono ainda não informou sai `null` — NUNCA um valor inventado.
 * Só dados que já são públicos por natureza (rodapé/política): nenhum segredo, nada de usuário.
 */
const router = Router()

router.get('/', (_req, res) => {
  res.setHeader('Cache-Control', 'public, max-age=300') // muda só em deploy (a versão sobe junto com o texto)
  res.json({ ...versoesVigentes(), company: dadosPublicosDaEmpresa() })
})

export default router
