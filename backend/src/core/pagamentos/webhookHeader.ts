/**
 * Nome do header estático em que a Cielo deve ecoar o segredo do webhook. Módulo PURO (sem env/logger) porque é lido por quem
 * verifica o segredo (`webhooksCielo.routes.ts`), por quem mostra o nome ao admin (`gatewayConfigDto.ts`) e por quem o esconde
 * dos logs (`lib/logRedactPaths.ts`) — uma fonte só, para os três não divergirem.
 *
 * SÓ LETRAS (C1.4, fato F27 provado no Parque em 02/09/2026): o campo "Key" do header no Site Cielo recusa hífen, número, espaço
 * e qualquer caractere especial — `X-Webhook-Secret` não pôde ser salvo. Uma notificação configurada com nome inválido seria
 * descartada em silêncio. HTTP não distingue maiúsculas: o Express entrega `req.header(...)` por qualquer caixa, e o Node
 * entrega as chaves de `req.headers` em minúsculas (por isso o path de redact usa `WEBHOOK_SECRET_HEADER_NAME_LOWER`).
 */
export const WEBHOOK_SECRET_HEADER_NAME = 'InnoFlowWebhookSecret'

/** Como o Node entrega a chave em `req.headers` (e como o redact/serializer a casam). */
export const WEBHOOK_SECRET_HEADER_NAME_LOWER = WEBHOOK_SECRET_HEADER_NAME.toLowerCase()

/** O que o Site Cielo aceita no campo "Key" do header: letras, e só. */
export const PADRAO_NOME_HEADER_SITE_CIELO = /^[A-Za-z]+$/
