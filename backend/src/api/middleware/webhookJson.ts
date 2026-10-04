import express, { type NextFunction, type Request, type RequestHandler, type Response } from 'express'

/**
 * Parser JSON PRÓPRIO do webhook da Cielo (I-5 da auditoria) — montado na rota, e o `express.json()` global PULA este caminho (ver `app.ts`).
 *  - limite de 4 KB (o "Post de Notificação" tem poucos campos; o padrão global de 100 KB dá a qualquer anônimo um corpo grande por requisição);
 *  - JSON MALFORMADO não é erro: vira corpo vazio e segue. A Cielo exige 200 no POST de teste ao salvar a URL (F26/F28); se ele vier com JSON quebrado o ping falharia. Quem decide
 *    o que fazer com corpo vazio é a rota (token do caminho primeiro, depois o ping 200);
 *  - corpo acima do limite segue como erro `entity.too.large` (413 no `errorHandler`, sem log de erro).
 */
export const CAMINHO_WEBHOOK_CIELO = '/api/webhooks/cielo'
export const LIMITE_CORPO_WEBHOOK = '4kb'

export function webhookJsonParser(): RequestHandler {
  const parser = express.json({ limit: LIMITE_CORPO_WEBHOOK })
  return (req: Request, res: Response, next: NextFunction) => {
    parser(req, res, (err?: unknown) => {
      if (err && (err as { type?: unknown }).type === 'entity.parse.failed') {
        req.body = {}
        next()
        return
      }
      next(err)
    })
  }
}

/** O `express.json()` global NÃO deve tocar no webhook: o parser dele (4 KB, tolerante) vem na própria rota. */
export function pularNoWebhook(parser: RequestHandler): RequestHandler {
  return (req, res, next) => {
    if (req.path === CAMINHO_WEBHOOK_CIELO || req.path.startsWith(`${CAMINHO_WEBHOOK_CIELO}/`)) {
      next()
      return
    }
    parser(req, res, next)
  }
}
