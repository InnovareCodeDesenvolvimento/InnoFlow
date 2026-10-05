import { Router } from 'express'
import { asyncHandler } from '../middleware/asyncHandler'
import { getDadosLegais } from '../../services/legal/dadosLegais'

/**
 * `GET /api/public/legal` — termos de uso/privacidade: versão VIGENTE e dados públicos da empresa (controlador, suporte, encarregado/DPO). Sem auth, atrás de `publicRateLimit`.
 * Contrato: `PublicLegalConfig` em `frontend/src/types/api.ts`. Os dados vêm do PAINEL (Admin > Dados da empresa, tabela `CompanyProfile`) e, na falta dele, das envs `LEGAL_*`
 * (ver `services/legal/dadosLegais.ts`); o que o dono ainda não informou sai `null` — NUNCA um valor inventado.
 * Só dados que já são públicos por natureza (rodapé/política): nenhum segredo, nada de usuário, nenhuma indicação de ONDE o dado foi cadastrado.
 * Cache curto: o dono pode mudar a versão/dados pelo painel, e uma versão velha em cache do navegador faria o front receber `TERMS_VERSION_OUTDATED` de novo ao recarregar.
 */
const router = Router()

router.get(
  '/',
  asyncHandler(async (_req, res) => {
    const dados = await getDadosLegais()
    res.setHeader('Cache-Control', 'public, max-age=30')
    res.json({ ...dados.versoes, company: dados.empresa })
  }),
)

export default router
