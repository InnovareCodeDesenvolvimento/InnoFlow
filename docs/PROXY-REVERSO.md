# Proxy reverso — nota para quando ele entrar (Nova, arquitetura)

Nenhum proxy reverso sobe nesta fase (F0) — `api`, `ocpp-gateway` e `worker`
são acessados direto pelas portas do `docker-compose.yml` da raiz. Esta nota
existe para quando um proxy de verdade (nginx, Traefik, Caddy) entrar na
frente deles, em deploy (Fase 8) ou antes, se o dono decidir.

## O que o proxy precisa ter, sem exceção

1. **Upgrade de WebSocket habilitado** na rota do `ocpp-gateway`
   (`Connection: upgrade`, `Upgrade: websocket` repassados). Sem isso, o
   handshake OCPP 1.6-J nunca completa — o charge point tenta conectar e
   cai imediatamente, parecendo um bug de rede.

2. **`proxy_read_timeout` (ou equivalente) MAIOR que o heartbeat OCPP.**
   O charge point manda `Heartbeat` periodicamente (tipicamente configurado
   em ~120s, ver `BootNotification`/`heartbeatInterval`). Se o timeout do
   proxy for igual ou menor que o intervalo de heartbeat, ele derruba a
   conexão pouco antes do próximo heartbeat chegar — parece intermitência
   de hardware quando é configuração de proxy.
   - Recomendação: `proxy_read_timeout` em pelo menos **300s** contra um
     heartbeat de referência de **120s** (fator de folga ~2.5x, não só
     "maior que").

3. **Buffering desligado nas rotas SSE** da API (`proxy_buffering off` no
   nginx, ou equivalente). Com buffering ligado, o proxy acumula a resposta
   antes de repassar ao cliente — o browser não recebe evento nenhum até o
   buffer encher ou a conexão fechar, o que quebra o propósito de SSE
   (atualização em tempo real do status da sessão de carga).

## Onde isso se conecta no código

- `ocpp-gateway`: `backend/src/entrypoints/ocpp.ts` / `backend/src/ocpp/`.
- SSE: `backend/src/api/sse/` (ainda vazio nesta fase — o Vega implementa).

Quando o proxy for configurado de verdade, o arquivo de config dele
(`nginx.conf`/`Caddyfile`/...) deve viver em `docs/` ou num serviço próprio
do `docker-compose.yml`, referenciando este documento no comentário de
topo — para quem debugar uma queda de conexão silenciosa encontrar a causa
raiz em segundos, não depois de horas comparando logs de charge point com
logs de proxy.
