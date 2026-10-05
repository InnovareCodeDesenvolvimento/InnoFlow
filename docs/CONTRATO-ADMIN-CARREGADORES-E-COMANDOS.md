# Contrato — DTO admin de carregadores, consulta de comando remoto e CORS (Vega-J)

Três ajustes ADITIVOS (nada removido nem renomeado). Fonte de verdade do código:
`backend/src/api/routes/chargePoints.routes.ts`, `adminCommands.routes.ts`, `api/app.ts`.

## 1. `online` no DTO admin de carregadores

Vale para **todas** as respostas que devolvem um carregador: `GET /api/admin/charge-points` (cada item de `items`), `GET /api/admin/charge-points/:id`, `POST` (201) e `PATCH` (200).

```ts
interface ChargePoint {
  // ... campos atuais ...
  online: boolean                 // NOVO. Calculado pelo SERVIDOR (regra única isChargePointOnline). Não refazer no front.
  lastSeenAt: string | null       // já ia no JSON (ISO 8601); null = nunca reportou. Só informativo.
  connectedAt: string | null      // já ia no JSON (última conexão do WebSocket, relógio do servidor)
  disconnectedAt: string | null   // já ia no JSON (último close do WebSocket)
}
```

`online = lastSeenAt existe E não (disconnectedAt >= lastSeenAt) E (agora - lastSeenAt) < 5 min`. Quem usar só `lastSeenAt` no navegador erra (relógio do cliente + ignora a queda registrada em `disconnectedAt`).
`basicAuthSecretHash` continua NUNCA saindo.

## 2. `sessionId` em `GET /api/admin/commands/:correlationId`

```ts
interface AdminCommandStatusResponse {
  status: 'PENDING' | 'ACCEPTED' | 'REJECTED' | 'TIMEOUT'
  /** NOVO, opcional. Só presente quando status === 'ACCEPTED' E o comando é um remote-start. */
  sessionId?: string | null
}
```

- `sessionId: string` = a sessão nascida deste comando.
- `sessionId: null` = o carregador aceitou o RemoteStart, mas o `StartTransaction` (que cria a sessão) ainda não chegou — **refaça a consulta** (o registro do comando vive 2 min; depois disso 404 `COMMAND_NOT_FOUND`, e o front passa a procurar a sessão ativa pela lista de sessões).
- Chave **ausente** em PENDING/REJECTED/TIMEOUT e em comandos que não são remote-start (hoje só o remote-start é consultável por este endpoint).
- Segurança: a sessão é achada pelo idTag virtual único do comando + motorista + charge point + escopo do operador de quem consulta. Um OPERATOR nunca recebe sessão de outro operador (recebe o mesmo 404 de sempre); o idTag nunca aparece na resposta.
- Registros gravados antes deste deploy (sem idTag) respondem como antes (sem `sessionId`) — vivem no máximo 2 min.

## 3. CORS — `Retry-After` legível entre domínios

`Access-Control-Expose-Headers: Retry-After` agora vai em toda resposta a origem permitida (inclusive 429 do rate limit e do bloqueio de login). O front pode ler `response.headers.get('Retry-After')` (segundos) mesmo com a API em outro domínio. Nada mais mudou no CORS: allowlist `CORS_ALLOWED_ORIGINS` (fail-closed, 403 `CORS_FORBIDDEN`), métodos, cabeçalhos aceitos e sem credenciais.
