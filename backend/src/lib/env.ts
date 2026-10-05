import { z } from 'zod'
import { envBoolean } from './envBoolean'

/**
 * Validação de variáveis de ambiente — falha rápido no boot em vez de
 * quebrar em produção na primeira query/conexão que precisar delas.
 *
 * Cada entrypoint (api.ts/ocpp.ts/worker.ts) só usa o subconjunto que
 * precisa, mas validamos tudo de uma vez: mais simples que 3 schemas
 * parciais, e um `.env` incompleto aparece cedo, não só quando o processo
 * errado sobe.
 */
const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.string().default('info'),

  DATABASE_URL: z.string().min(1, 'DATABASE_URL é obrigatório'),
  REDIS_URL: z.string().min(1, 'REDIS_URL é obrigatório'),

  PORT: z.coerce.number().int().positive().default(3000),
  OCPP_PORT: z.coerce.number().int().positive().default(9000),

  // Auth da API REST (JWT). Sem default de propósito — segredo fraco/ausente
  // em produção não pode passar despercebido; falha o boot.
  // DOIS PAPÉIS (desde 05/10/2026): assina as sessões (HS256) E é a FONTE da chave que cifra os segredos em repouso (scrypt com salt fixo, `lib/crypto/paymentSecrets.ts`).
  // Trocar = derruba as sessões + torna ilegíveis os segredos salvos (gateway, e-mail/WhatsApp, backup) e os cartões dos motoristas. Guarde uma cópia FORA do EasyPanel.
  JWT_SECRET: z.string().min(16, 'JWT_SECRET é obrigatório e precisa ter pelo menos 16 caracteres'),
  JWT_EXPIRES_IN: z.string().default('12h'),

  // Identidade deste processo no barramento de comandos OCPP (Redis) e no
  // lock anti-split-brain (ocpp:conn:{chargePointId}). Default: um UUID novo
  // por processo — só precisa ser estável se algum dia quisermos afinidade
  // determinística entre réplicas (não é o caso agora).
  OCPP_NODE_ID: z.string().optional(),

  // Fuso padrão dos relatórios/dashboard administrativo (módulo de
  // retaguarda) quando o cliente não manda `?tz=` e a query não é escopada a
  // um único site (relatório "por eletroposto" usa Site.timezone). Tem
  // default de propósito — campo novo obrigatório sem default derrubaria os
  // 3 entrypoints no boot (ver bug-env-eager-todos-entrypoints.md).
  REPORTING_TIMEZONE: z.string().trim().min(1).default('America/Sao_Paulo'),

  // F4 (2026-09-17) — carteira pré-paga sem hold. Defaults de propósito
  // (mesma lição do bug-env-eager-todos-entrypoints.md): um campo novo
  // obrigatório sem default derrubaria os 3 entrypoints no boot, não só quem
  // de fato usa. Valor real de produção pode ser ajustado por env sem
  // redeploy de código.
  //
  // Saldo mínimo para AUTORIZAR o início de uma sessão — decisão do dono,
  // 2026-09-17: R$ 20,00.
  WALLET_MIN_START_BALANCE_CENTS: z.coerce.number().int().min(0).default(2000),
  // Clamp do teto de custo estimado (`calcularTetoReserva`) — usado só como
  // referência para a guarda ao vivo do MeterValues, NUNCA reservado/debitado
  // antecipadamente (ver decisão da Nova sobre a identidade de conciliação).
  RESERVA_PISO_CENTS: z.coerce.number().int().positive().default(5000),
  RESERVA_TETO_CENTS: z.coerce.number().int().positive().default(40000),

  // Achado da auditoria do Órion (2026-09-17, "importante"): `cors()` sem
  // args aceita QUALQUER origem. Allowlist explícita, separada por vírgula.
  // Default cobre só o dev local (Vite `5173`, `vite preview` `4173`) — em
  // produção o valor real (domínio `*.easypanel.host` do frontend) tem que
  // vir da env. Fail-CLOSED de propósito: esquecer de configurar em produção
  // derruba o frontend na hora (sintoma óbvio no navegador — erro de CORS no
  // console), o que é preferível a abrir silenciosamente para qualquer
  // origem.
  CORS_ALLOWED_ORIGINS: z
    .string()
    .default('http://localhost:5173,http://localhost:4173')
    .transform((value) =>
      value
        .split(',')
        .map((origin) => origin.trim())
        .filter(Boolean),
    ),

  // Rate limit do auth OCPP (achado "importante" do Órion) — mesmo espírito
  // do rate limit de login da API REST (`middleware/rateLimit.ts`): N
  // tentativas falhas por identidade/janela, contador em Redis (o gateway
  // roda em processo separado da API, precisa de estado compartilhado).
  OCPP_AUTH_RATE_LIMIT_MAX_ATTEMPTS: z.coerce.number().int().positive().default(5),
  OCPP_AUTH_RATE_LIMIT_WINDOW_SECONDS: z.coerce.number().int().positive().default(300),
  // Órion A1 (2026-09-19): o contador por identidade sozinho deixava um atacante TRAVAR o carregador
  // real (identidade é pública em `GET /api/sites`). Agora: `OCPP_AUTH_RATE_LIMIT_MAX_ATTEMPTS` vale
  // por (identidade + IP) e este é o limite GLOBAL de falhas por IP (cobre identidade inexistente).
  // Alto de propósito: um IP legítimo (frota atrás de NAT) quase não falha.
  OCPP_AUTH_IP_MAX_FAILURES: z.coerce.number().int().positive().default(30),
  // Tentativas de autenticação de um IP EM ANDAMENTO ao mesmo tempo (banco + bcrypt de cada uma). Separado
  // do limite de falhas de propósito: uma frota atrás de um mesmo NAT reconectando junta (restart do
  // gateway) tem dezenas de handshakes legítimos simultâneos e nenhuma falha. Dimensione para o maior
  // site atrás de um IP; acima disto o excedente leva 429 e o carregador tenta de novo no backoff. Custo:
  // uma rajada de tentativas que FALHAM pode produzir até este número de falhas de uma vez antes de o
  // bloqueio por falhas valer (ver `core/ocpp/authRateLimiter.ts`).
  OCPP_AUTH_IP_MAX_CONCURRENT: z.coerce.number().int().positive().default(100),
  // Quantos proxies reversos há entre o carregador e a porta do gateway (9000) — resolve o IP do
  // handshake a partir do X-Forwarded-For (mesma semântica de `TRUST_PROXY_HOPS` da API, mas o
  // caminho até a porta 9000 é OUTRO). Default 0 = confia só no endereço do socket (seguro se a
  // porta é exposta direto; o X-Forwarded-For seria forjável). Atrás de proxy, sem configurar, todos
  // os carregadores compartilham o IP do proxy — ver o log `[ocpp] auth` (clientIp/xForwardedFor)
  // para conferir o valor certo ANTES de confiar em hops > 0.
  OCPP_TRUST_PROXY_HOPS: z.coerce.number().int().min(0).max(5).default(0),
  // N-10 (Órion, 05/10/2026): limite de mensagens RECEBIDAS por conexão, em janela deslizante (excedeu -> fecha 1008 + log `alert`).
  // Default 1000 em 10 s (100/s): 50x o regime normal de um carregador e acima do replay offline serial — racional em `core/ocpp/limiteMensagens.ts`.
  OCPP_MESSAGE_RATE_MAX: z.coerce.number().int().positive().default(1000),
  OCPP_MESSAGE_RATE_WINDOW_SECONDS: z.coerce.number().int().positive().default(10),

  // Achado da Nova (log de auditoria, 2026-09-17): `app.set('trust proxy')`
  // nunca existiu neste backend. Sem isto, `req.ip` em produção é sempre o
  // IP do container do proxy do EasyPanel (nginx do frontend -> rede interna
  // -> container da API) — o campo `ipAddress` do audit log nasceria sempre
  // igual (inútil) e o rate limit de login por IP conta a internet inteira
  // num balde só. Número de hops (não `true` cego).
  //
  // CORRIGIDO 19/09/2026 (evidência de produção): o default era 1 ("nginx do
  // frontend é o único proxy") e estava ERRADO — são 2 proxies entre o
  // cliente e o Express: o edge do EasyPanel e o nginx do frontend. Log real:
  // `x-forwarded-for: "179.104.42.35, 10.11.0.16"` + socket `10.11.0.16`, e o
  // audit log gravou `ipAddress: "10.11.0.16"` (IP do proxy, não do cliente)
  // — com isso o rate limit de login por IP continuava contando TODOS os
  // usuários num balde só. Reproduzido: hops=1 -> 10.11.0.16; hops=2 ->
  // 179.104.42.35 (e um cliente forjando X-Forwarded-For NÃO vira o IP dele).
  // Se a topologia mudar (CDN/LB novo na frente), reconfira com um log real
  // antes de mexer: hops a MAIS deixa o cliente forjar o próprio IP.
  TRUST_PROXY_HOPS: z.coerce.number().int().min(0).default(2),

  // Log de auditoria (Nova, 2026-09-17) — teto de tamanho do diff gravado em
  // `AuditLog.changes` (allowlist por entidade, nunca payload cru). Acima
  // disso grava só `{ truncated: true }` em vez do diff.
  AUDIT_LOG_CHANGES_MAX_BYTES: z.coerce.number().int().positive().default(8192),

  // Canal SSE (tempo real) — intervalo de heartbeat (`:ping`) para o nginx
  // não cortar a conexão por inatividade (janela de proxy é bem maior, mas
  // não vale deixar a conexão muda por tanto tempo) e throttle mínimo do
  // evento `dashboard.dirty` (nunca recalcula agregado por evento — só
  // invalida a query no máximo nesta cadência).
  // Login/cadastro de motorista com Google (2026-09-19). OPCIONAL: sem ele o
  // login com Google fica desligado (`GET /api/public/config` devolve `null`,
  // `POST /api/auth/google` responde 503 `GOOGLE_NOT_CONFIGURED`). O client ID
  // é PÚBLICO por desenho do Google — mora aqui (não no build do frontend)
  // para dar pra ligar/desligar sem rebuild. `preprocess` transforma string
  // vazia em `undefined`: o EasyPanel guarda uma env "em branco" como `""`, e
  // `.min(1)` puro derrubaria o boot dos 3 entrypoints por causa de uma
  // feature opcional (mesma lição de bug-env-eager-todos-entrypoints.md).
  GOOGLE_CLIENT_ID: z.preprocess((v) => (typeof v === 'string' && v.trim() === '' ? undefined : v), z.string().trim().min(1).optional()),

  // L1.9 (06/10/2026) — termos de uso e política de privacidade: VERSÃO VIGENTE + dados públicos da empresa (controlador, suporte, encarregado/DPO).
  // RESERVA desde o pedido do dono (06/10/2026): o painel (Admin > Dados da empresa, tabela `CompanyProfile`) MANDA; estas envs só valem enquanto nada foi salvo lá
  // (`services/legal/dadosLegais.ts`). Seguem lidas aqui por serem o fallback e o padrão das versões — suba a env no MESMO deploy do texto novo se não usar o painel. Versões com default (o boot dos 3 entrypoints não pode
  // depender de uma decisão jurídica do dono) e no máximo 32 caracteres (coluna `ConsentRecord.version`). Dados da empresa OPCIONAIS e SEM default: o dono ainda não informou CNPJ,
  // razão social, e-mail de suporte nem DPO — vazio vira `null` em `GET /api/public/legal`, nunca placeholder inventado. Valor inválido (e-mail/CNPJ malformado) é IGNORADO com aviso
  // no log (`core/legal/termos.ts`), nunca derruba o boot por causa de um campo cosmético.
  LEGAL_TERMS_VERSION: z.preprocess((v) => (typeof v === 'string' && v.trim() === '' ? undefined : v), z.string().trim().min(1).max(32).default('2026-10-05')),
  LEGAL_PRIVACY_VERSION: z.preprocess((v) => (typeof v === 'string' && v.trim() === '' ? undefined : v), z.string().trim().min(1).max(32).default('2026-10-05')),
  LEGAL_COMPANY_NAME: z.preprocess((v) => (typeof v === 'string' && v.trim() === '' ? undefined : v), z.string().trim().max(400).optional()),
  LEGAL_COMPANY_CNPJ: z.preprocess((v) => (typeof v === 'string' && v.trim() === '' ? undefined : v), z.string().trim().max(40).optional()),
  LEGAL_SUPPORT_EMAIL: z.preprocess((v) => (typeof v === 'string' && v.trim() === '' ? undefined : v), z.string().trim().max(400).optional()),
  LEGAL_SUPPORT_PHONE: z.preprocess((v) => (typeof v === 'string' && v.trim() === '' ? undefined : v), z.string().trim().max(400).optional()),
  LEGAL_DPO_EMAIL: z.preprocess((v) => (typeof v === 'string' && v.trim() === '' ? undefined : v), z.string().trim().max(400).optional()),

  // F5.1 (30/09/2026) — cliente Cielo (gateway de pagamento real, ver
  // .claude/agent-memory/nova/decisoes-f5-pagamento-cielo.md). Credenciais
  // OPCIONAIS de propósito (mesma lição de bug-env-eager-todos-entrypoints.md):
  // sem elas, o `CieloAdapter` falha ao ser CONSTRUÍDO/USADO (erro explícito
  // no ponto de uso), não no boot dos 3 entrypoints — a F5.1 não pluga isto
  // em nenhuma rota ainda. Hosts default apontam para o SANDBOX oficial da
  // Cielo (API 3.0); produção troca só a env, sem rebuild.
  CIELO_MERCHANT_ID: z.preprocess((v) => (typeof v === 'string' && v.trim() === '' ? undefined : v), z.string().trim().min(1).optional()),
  CIELO_MERCHANT_KEY: z.preprocess((v) => (typeof v === 'string' && v.trim() === '' ? undefined : v), z.string().trim().min(1).optional()),
  CIELO_API_BASE_URL: z.string().trim().min(1).default('https://apisandbox.cieloecommerce.cielo.com.br'),
  CIELO_API_QUERY_BASE_URL: z.string().trim().min(1).default('https://apiquerysandbox.cieloecommerce.cielo.com.br'),
  // `envBoolean`, NÃO `z.coerce.boolean()` — este tratava "false"/"0" como true (ver `envBoolean.ts`).
  // Default `true` (sandbox) de propósito: esquecer a env nunca aponta para produção.
  CIELO_SANDBOX: envBoolean(true),
  // Opt-in EXPLÍCITO para usar o `FakeAdapter` em produção (default false). O Fake aprova QUALQUER cartão e não
  // cobra nada — sem esta env, produção sem `CIELO_MERCHANT_ID`/`CIELO_MERCHANT_KEY` bloqueia Pix/cartão (503).
  // Ver `core/pagamentos/decidirAdaptador.ts`. Só ligue para demonstrar o fluxo sabendo que NADA é cobrado.
  PAYMENT_ALLOW_FAKE_ADAPTER: envBoolean(false),
  // F5.3 (30/09/2026) — sessão de tokenização de cartão (Silent Order Post,
  // D1 do dono: cartão salvo, SAQ A-EP). Substitui `CIELO_SOP_POST_URL` da
  // F5.1 (nunca chegou a ser configurada/usada): o contrato real que o
  // frontend consome (`MeCardTokenizationSessionResponse`) pede `scriptUrl`
  // (a página isolada da Lyra carrega o script da Cielo, não faz POST de
  // formulário pelo nosso backend) + um `accessToken` de sessão. Nenhuma das
  // 4 envs abaixo foi confirmada contra doc/sandbox real (sem credencial) —
  // `CieloAdapter.sessaoTokenizacao()` lança erro claro se faltar alguma, em
  // vez de inventar URL/mecanismo. `sopClientId`/`sopClientSecret` espelham
  // o par que o Cronos já previu em `PaymentGatewayConfig` (OAuth
  // client_credentials — ver `services/pagamentos/cieloSopOAuth.ts`).
  CIELO_SOP_SCRIPT_URL: z.preprocess((v) => (typeof v === 'string' && v.trim() === '' ? undefined : v), z.string().trim().url().optional()),
  CIELO_SOP_CLIENT_ID: z.preprocess((v) => (typeof v === 'string' && v.trim() === '' ? undefined : v), z.string().trim().min(1).optional()),
  CIELO_SOP_CLIENT_SECRET: z.preprocess((v) => (typeof v === 'string' && v.trim() === '' ? undefined : v), z.string().trim().min(1).optional()),
  CIELO_SOP_OAUTH_TOKEN_URL: z.preprocess((v) => (typeof v === 'string' && v.trim() === '' ? undefined : v), z.string().trim().url().optional()),
  // C1.1: as 3 URLs do SOP (OAuth, emissão do AccessToken, script) têm DEFAULT por ambiente (`URLS_SOP` em `core/pagamentos/configGateway.ts`, as mesmas do
  // Parque das Feiras). As 3 envs `CIELO_SOP_*_URL` são só OVERRIDE opcional (servidor falso em teste, URL canônica nova da Cielo) — não são requisito.
  CIELO_SOP_ACCESS_TOKEN_URL: z.preprocess((v) => (typeof v === 'string' && v.trim() === '' ? undefined : v), z.string().trim().url().optional()),
  // Timeout de chamada — curto de propósito: o motorista está esperando num
  // HTTP síncrono (`POST /api/me/sessions/start`, decisão #2 da Nova), não
  // faz sentido segurá-lo por dezenas de segundos. Timeout NÃO deve disparar
  // retry cego — a API 3.0 da Cielo não tem chave de idempotência; o
  // caminho certo é reconsultar por `MerchantOrderId` (ver `PagamentoPort`).
  // S-6 (auditoria): 8 s multiplicava os timeouts do `POST /1/sales` e do `PUT /capture` — exatamente os caminhos que dependem da reconciliação. O Parque usa 20 s. ESTE é o prazo das ESCRITAS
  // (POST/PUT) e do SOP; as CONSULTAS (GET) usam `CIELO_QUERY_TIMEOUT_MS`, menor. O lock da captura/cancelamento (`max(60 s, 6 x isto)`) acompanha.
  CIELO_TIMEOUT_MS: z.coerce.number().int().positive().default(20_000),
  CIELO_QUERY_TIMEOUT_MS: z.coerce.number().int().positive().default(8_000),
  // I-7 (decisão do dono, 04/10/2026): pagar com CARTÃO exige identidade verificada (Google). Padrão: LIGADO em produção, desligado em dev/CI (o seed e as fixtures usam motoristas só-senha) — `true`/`false`
  // explícito vence. Ver `services/pagamentos/elegibilidadeCartao.ts`.
  CARD_REQUIRE_VERIFIED_IDENTITY: envBoolean(process.env.NODE_ENV === 'production'),
  // Bloqueio por recusas (carding): cartão fica indisponível (429 CARD_TEMPORARILY_BLOCKED) quando o usuário acumula recusas de cartão na janela de 24 h, o mesmo IP acumula recusas na janela de 1 h,
  // ou o usuário tenta cadastrar cartões demais em 24 h. Janela FIXA contada a partir do 1º evento; só vale para CARTÃO (Pix e carteira seguem).
  CARD_BLOCK_MAX_REFUSALS_PER_USER_DAY: z.coerce.number().int().positive().default(3),
  CARD_BLOCK_MAX_REFUSALS_PER_IP_HOUR: z.coerce.number().int().positive().default(10),
  CARD_BLOCK_MAX_REGISTRATIONS_PER_USER_DAY: z.coerce.number().int().positive().default(10),
  // Descritor na fatura do cartão (A-Z0-9, até 13). A conta Cielo é COMPARTILHADA com o Parque das Feiras: o descritor distingue as cobranças do InnoFlow na fatura. Higienizado em runtime.
  CIELO_SOFT_DESCRIPTOR: z.string().trim().max(60).default('INNOFLOW'),
  // Crédito do Pix por POLLING (a conta Cielo compartilhada não tem webhook do InnoFlow): intervalo do varredor e idade mínima do Pix antes da 1ª consulta.
  TOPUP_PIX_POLL_INTERVAL_MS: z.coerce.number().int().positive().default(15_000),
  TOPUP_PIX_POLL_MIN_AGE_MS: z.coerce.number().int().min(0).default(15_000),

  // F5.2 (30/09/2026) — recarga de carteira via Pix real. Expiração do QR:
  // Nova recomendou 30 min (NÃO o default de 86400s/24h da própria Cielo) —
  // ver decisoes-f5-pagamento-cielo.md. Configurável por env sem redeploy.
  PIX_TOPUP_EXPIRES_MINUTES: z.coerce.number().int().positive().default(30),
  // Quantas recargas Pix PENDING um motorista pode ter em aberto ao mesmo
  // tempo — 1 por padrão (gerar um novo Pix enquanto o anterior ainda pode
  // ser pago seria confuso: qual QR o motorista deveria pagar?).
  TOPUP_PIX_MAX_PENDING_PER_USER: z.coerce.number().int().positive().default(1),
  // Cadência do varredor de expiração (BullMQ repeatable, `worker/jobs/
  // expirarTopupsPixJob.ts`) — reconsulta a Cielo ANTES de marcar EXPIRED
  // (decisão da tarefa: pagamento que chega depois do prazo do QR ainda
  // credita, o dinheiro entrou e não dá pra recusar).
  TOPUP_PIX_EXPIRY_SCAN_INTERVAL_MS: z.coerce.number().int().positive().default(60_000),

  // Webhook da Cielo (`POST /api/webhooks/cielo/:pathToken`, público, sem
  // JWT — F5.2). OPCIONAIS com default GERADO por processo (mesmo padrão de
  // `OCPP_NODE_ID` já usado neste projeto: `env.X || randomUUID()` no ponto
  // de uso, não aqui) — sem configurar em produção, o segredo vira um UUID
  // novo a cada boot, o que na prática significa "ninguém de fora consegue
  // chamar esta rota até alguém configurar de verdade" (fail-CLOSED por
  // desenho, mesmo espírito de CORS_ALLOWED_ORIGINS). `pathToken` é só
  // ROTEAMENTO (comparado por igualdade simples); `webhookHeaderSecret` é o
  // segredo de verdade (comparado em tempo constante, ver
  // `core/pagamentos/verificarSegredoWebhook.ts`).
  CIELO_WEBHOOK_PATH_TOKEN: z.preprocess((v) => (typeof v === 'string' && v.trim() === '' ? undefined : v), z.string().trim().min(8).optional()),
  CIELO_WEBHOOK_HEADER_SECRET: z.preprocess((v) => (typeof v === 'string' && v.trim() === '' ? undefined : v), z.string().trim().min(8).optional()),

  // MUDANÇA DELIBERADA (05/10/2026, decisão do dono: "como no InnoChat"): a chave AES-256-GCM dos segredos em repouso (`PaymentMethod.cieloCardTokenCiphertext`,
  // `PaymentGatewayConfig.*Ciphertext`, comunicação, backup, chave Pix de devolução — ver `lib/crypto/paymentSecrets.ts`) é DERIVADA do `JWT_SECRET` via scrypt com salt fixo
  // próprio do InnoFlow. `PAYMENT_SECRETS_KEY` deixou de ser necessária: é um OVERRIDE OPCIONAL (base64 de 32 bytes, `openssl rand -base64 32`) — se definida e válida, vale
  // exatamente como antes (compatibilidade e rotação avançada com `_PREVIOUS`); definida e INVÁLIDA => chave-mestra indisponível (fail-closed, alerta). Ausente => usa a derivada.
  // OPCIONAL/sem default de propósito (bug-env-eager-todos-entrypoints.md). A chave NUNCA vive no banco.
  // ATENÇÃO: o `JWT_SECRET` tem DOIS papéis agora (assina as sessões E deriva a chave dos segredos): trocá-lo derruba as sessões, apaga (torna ilegíveis) os segredos salvos e os
  // cartões dos motoristas. Guarde uma cópia fora do EasyPanel. Runbook: docs/DEPLOY-EASYPANEL.md, "Trocar o JWT_SECRET".
  PAYMENT_SECRETS_KEY: z.preprocess((v) => (typeof v === 'string' && v.trim() === '' ? undefined : v), z.string().trim().min(1).optional()),
  // F5.7 — chave ANTERIOR da rotação (da chave-mestra: override ou, ao voltar do override para a derivada, o override antigo): só DECIFRA (o que for gravado usa sempre a atual). OPCIONAL; ver o runbook de rotação em
  // `docs/DEPLOY-EASYPANEL.md` e `lib/crypto/paymentSecrets.ts`. Remova depois de rodar `scripts/recifrarSegredosDePagamento.ts --apply`.
  PAYMENT_SECRETS_KEY_PREVIOUS: z.preprocess((v) => (typeof v === 'string' && v.trim() === '' ? undefined : v), z.string().trim().min(1).optional()),

  // F5.7 (ALTO-2) — SANDBOX em servidor de PRODUÇÃO (`NODE_ENV=production` com ambiente efetivo do gateway = sandbox) só funciona para os
  // e-mails desta lista (separados por vírgula, sem distinguir maiúsculas; OPCIONAL — vazia/ausente = NINGUÉM: falha segura). Os cartões de
  // teste da Cielo são públicos e o cadastro do app é aberto: sem a trava, sandbox numa instância pública seria cobrança grátis para qualquer um.
  // O valor são e-mails (dado pessoal): nunca vai para log nem para a resposta. Ver `core/pagamentos/configGateway.ts` (`sandboxRestrito`).
  PAYMENT_SANDBOX_TESTER_EMAILS: z.preprocess((v) => (typeof v === 'string' && v.trim() === '' ? undefined : v), z.string().trim().max(4000).optional()),

  // F5.5 (02/10/2026) — URL pública da API (ex.: https://api.exemplo.com.br), usada só para MONTAR a
  // `webhookUrl` que a tela do gateway mostra ao dono (cadastrar no Site Cielo). OPCIONAL: sem ela a rota
  // deriva do próprio request (protocolo/host respeitando `TRUST_PROXY_HOPS`) — que funciona quando o proxy
  // repassa Host/X-Forwarded-*, mas uma env explícita não depende disso.
  PUBLIC_API_BASE_URL: z.preprocess((v) => (typeof v === 'string' && v.trim() === '' ? undefined : v), z.string().trim().url().optional()),

  // L1.3 (05/10/2026) — origem PÚBLICA do FRONTEND (ex.: https://innoflow.innovarecode.com.br), usada para montar os links dos e-mails (redefinir senha).
  // NUNCA derivada do header Host/X-Forwarded-Host da requisição (host header injection: quem pede o e-mail de outra pessoa poderia fazê-lo apontar para um domínio
  // do atacante). OPCIONAL: sem ela cai na PRIMEIRA origem de `CORS_ALLOWED_ORIGINS` (já é o domínio do frontend, definido pelo dono); sem nenhuma utilizável
  // (produção com localhost/http) o e-mail de link NÃO é enviado e o erro é logado. Só a ORIGEM é usada (caminho/query descartados).
  PUBLIC_APP_URL: z.preprocess((v) => (typeof v === 'string' && v.trim() === '' ? undefined : v), z.string().trim().url().optional()),
  // L1.3 — teto GLOBAL de e-mails de redefinição realmente enviados por hora (todos os destinatários): o SMTP do dono não pode virar relé de spam para endereços alheios
  // por quem varre e-mails de várias origens (o limite por e-mail e por IP já barra o martelo em UM endereço/UM IP). Conta só envios reais (e-mail inexistente não gasta).
  PASSWORD_RESET_MAX_EMAILS_PER_HOUR: z.coerce.number().int().positive().default(500),

  // F5.4 (30/09/2026) — sessão de recarga cobrando de cartão (pré-auth +
  // captura parcial via PaymentIntent). Cadência do varredor de
  // pré-autorizações (`worker/jobs/varrerPreAutorizacoesCartaoJob.ts`) — mesmo
  // padrão/default de `TOPUP_PIX_EXPIRY_SCAN_INTERVAL_MS`.
  CARD_PREAUTH_SCAN_INTERVAL_MS: z.coerce.number().int().positive().default(60_000),
  // L1.8 (estorno pelo portal da Cielo): o job confirmarEstornosPortal reconsulta, de tempos em tempos, as devoluções registradas pelo ADMIN (PENDING_CONFIRMATION). Baixa frequência de propósito
  // (30 min): cada rodada faz UMA consulta de venda por pedido pendente numa conta Cielo COMPARTILHADA com o Parque, e o estorno no portal leva horas/dias para aparecer.
  REFUND_PORTAL_SCAN_INTERVAL_MS: z.coerce.number().int().min(60_000).default(1_800_000),
  // Janela (dias, contados da data da VENDA) em que a consulta de venda da Cielo ainda responde (~3 meses; 85 d deixa folga). Passada a janela o job PARA de reconsultar e só alerta
  // (a confirmação passa a ser humana: conferir o extrato da Cielo e cancelar/registrar de novo).
  REFUND_PORTAL_RECONSULT_WINDOW_DAYS: z.coerce.number().int().min(1).max(365).default(85),
  // Idade (horas) a partir da qual uma devolução ainda PENDING_CONFIRMATION vira alerta (o ADMIN registrou, a Cielo não mostra o estorno).
  REFUND_PORTAL_PENDING_ALERT_HOURS: z.coerce.number().int().min(1).max(24 * 90).default(72),
  // Quanto tempo uma pré-autorização AUTHORIZED pode ficar sem `StartTransaction`
  // vinculado antes do varredor cancelá-la (VOIDED) — decisão do dono,
  // 2026-09-17, documentada em decisoes-f5-pagamento-cielo.md (mesma premissa
  // de "sessão longa típica" usada em `calcularTetoReserva`). Também usado
  // como o primeiro horizonte de desistência de um intent `CREATED` que nunca
  // recebeu resposta da Cielo (reconsultado antes; ver `varrerPreAutorizacoesCartao.ts`).
  CARD_PREAUTH_ABANDON_MINUTES: z.coerce.number().int().positive().default(5),
  // F5.7 (ALTO-1) — rede de segurança da CAPTURA. Um intent em `CAPTURE_PENDING` há mais que isto (minutos) é
  // REENFILEIRADO pelo varredor periódico (a captura é idempotente: reconsulta a Cielo antes de capturar). É também
  // o intervalo mínimo entre dois reenfileiramentos do MESMO intent.
  CARD_CAPTURE_RETRY_AFTER_MINUTES: z.coerce.number().int().positive().default(5),
  // Teto de reenfileiramentos do varredor por intent (com o default de 5 min são ~8 h). Ao atingir, PARA de
  // reenfileirar e só alerta (`payment_capture_retry_exhausted`, 1x/h) — decisão humana. Para retomar depois de
  // corrigir a causa: apagar a chave Redis `card-capture:sweeps:<intentId>`.
  CARD_CAPTURE_MAX_SWEEP_RETRIES: z.coerce.number().int().positive().default(100),

  // F5.9 (03/10/2026) — WATCHDOG DE SESSÃO TRAVADA (M5/M6). Desenho: .claude/agent-memory/nova/decisoes-f59-sessao-travada.md.
  // Decisão em `core/sessao/avaliarSessaoAberta.ts` (função pura; os defaults aqui TÊM de bater com `CONFIG_WATCHDOG_PADRAO` de lá —
  // um teste unitário trava isso). Todos têm default de propósito (campo novo sem default derrubaria os 3 entrypoints no boot).
  // KILL-SWITCH do watchdog (M4 do Órion). DEFAULT FALSE: no 1º deploy o watchdog NASCE desligado. Ordem de rollout: migration -> API e gateway ->
  // SÓ ENTÃO ligar (true) e subir o worker — um worker novo gerando STOP_UNCONFIRMED enquanto API/gateway antigos ainda não conhecem o enum quebra
  // handlers no meio do deploy rolante. Desligado: o job NÃO é agendado (o agendador antigo, se existir, é REMOVIDO), o processador ignora disparos
  // atrasados e `vigiarSessoes()` não age. Os handlers OCPP e as rotas (marcar no Boot, parar, stop tardio) seguem funcionando — só a vigilância periódica para.
  SESSION_WATCHDOG_ENABLED: envBoolean(false),
  // Cadência do job `vigiarSessoesJob` no worker (concurrency 1) e tamanho do lote por ciclo.
  SESSION_WATCHDOG_INTERVAL_MS: z.coerce.number().int().positive().default(60_000),
  SESSION_WATCHDOG_BATCH_SIZE: z.coerce.number().int().positive().default(100),
  // R1: carregador offline há >= isto E sessão sem atividade do servidor há >= SESSION_INACTIVITY_MINUTES => STOP_UNCONFIRMED.
  SESSION_CHARGER_OFFLINE_MINUTES: z.coerce.number().int().positive().default(10),
  SESSION_INACTIVITY_MINUTES: z.coerce.number().int().positive().default(15),
  // R2: conector online que voltou a AVAILABLE/UNAVAILABLE depois de a sessão abrir, há >= isto => STOP_UNCONFIRMED(CONNECTOR_IDLE).
  SESSION_CONNECTOR_IDLE_MINUTES: z.coerce.number().int().positive().default(5),
  // R3: espera pelo StopTransaction depois de um RemoteStop, e teto de RemoteStop por sessão (contando o 1º). D4 do dono: 3 + alerta.
  SESSION_STOP_CONFIRM_MINUTES: z.coerce.number().int().positive().default(5),
  SESSION_STOP_MAX_ATTEMPTS: z.coerce.number().int().positive().default(3),
  // R4: intervalo mínimo entre dois TriggerMessage(MeterValues) da mesma sessão (carregador online, CHARGING e mudo).
  SESSION_METER_TRIGGER_COOLDOWN_MINUTES: z.coerce.number().int().positive().default(15),
  // R5 (D5 do dono): idade máxima de uma sessão aberta.
  SESSION_MAX_OPEN_HOURS: z.coerce.number().int().positive().default(24),
  // U2: janela de confirmação em STOP_UNCONFIRMED antes de o servidor encerrar — carregador ONLINE agora / OFFLINE agora (D1 do dono: 2 h).
  SESSION_UNCONFIRMED_GRACE_ONLINE_MINUTES: z.coerce.number().int().positive().default(10),
  SESSION_UNCONFIRMED_GRACE_OFFLINE_MINUTES: z.coerce.number().int().positive().default(120),
  // Prazo máximo do hold da pré-autorização do cartão (horas desde `authorizedAt`): passou disso, encerra mesmo dentro da janela, com alerta
  // `card_session_hold_deadline`. A Cielo ainda não confirmou o prazo real de captura; 48 h tem muita folga.
  CARD_SESSION_MAX_HOLD_HOURS: z.coerce.number().int().positive().default(48),
  // D2 (DECISÃO DO DONO, ainda NÃO confirmada — default = recomendação da Nova): sessão encerrada pelo servidor SEM NENHUMA leitura de medidor.
  //   NO_CHARGE (D2a) = não cobra nada, alerta `session_closed_without_meter_reading` e fica para revisão manual. Nunca se estima energia por potência x tempo.
  //   MIN_FEE (D2b)   = comportamento de hoje: cobra a taxa fixa + o mínimo da tarifa (energia 0).
  // Valor fora dessas duas opções derruba o boot (não adivinhamos política de cobrança). Vazio = default.
  SESSION_NO_READING_POLICY: z.preprocess(
    (v) => (typeof v === 'string' ? (v.trim() === '' ? undefined : v.trim().toUpperCase()) : v),
    z.enum(['NO_CHARGE', 'MIN_FEE']).default('NO_CHARGE'),
  ),
  // D7 (DECISÃO DO DONO, ainda NÃO confirmada — default = D7a): o motorista pode iniciar OUTRA recarga enquanto a anterior está em
  // confirmação (STOP_UNCONFIRMED), descontando da carteira o saldo comprometido (`provisionalCostCents`)? false = D7b: bloqueia até confirmar.
  SESSION_ALLOW_START_WHILE_UNCONFIRMED: envBoolean(true),

  // N-11 (05/10/2026) — manutenção de partições (MeterSample/OcppMessage) e retenção. Ver `services/manutencao/` e a seção "Partições e retenção" de docs/DEPLOY-EASYPANEL.md.
  // Meses de partição a manter À FRENTE (o job cria o que faltar) e cadência do job (também roda 1x no boot do worker; idempotente, com lock consultivo).
  PARTITION_AHEAD_MONTHS: z.coerce.number().int().min(3).max(60).default(6),
  PARTITION_MAINTENANCE_INTERVAL_MS: z.coerce.number().int().min(60_000).default(86_400_000),
  // RETENÇÃO: DESLIGADA por padrão — ligada, purga por DETACH+DROP de partições INTEIRAS além do prazo (MeterSample/OcppMessage) e por DELETE em lotes (WebhookEvent/NotificationLog/AuditLog) — nunca o financeiro (WalletEntry etc.). DRY_RUN só loga o que removeria (só vale com ENABLED=true).
  // Prazos em dias (piso de 30) — DL6, decisão do dono (05/10/2026): MeterSample/OcppMessage 12 meses (365 d), WebhookEvent 180 d. Efetivo = prazo + até 1 mês (a partição só cai quando o mês INTEIRO passou do prazo).
  RETENTION_ENABLED: envBoolean(false),
  RETENTION_DRY_RUN: envBoolean(false),
  RETENTION_OCPP_MESSAGE_DAYS: z.coerce.number().int().min(30).default(365),
  RETENTION_METER_SAMPLE_DAYS: z.coerce.number().int().min(30).default(365),
  RETENTION_WEBHOOK_EVENT_DAYS: z.coerce.number().int().min(30).default(180),
  // L1.6/DL6: log das notificações por e-mail ao motorista (NotificationLog) — 12 meses (365 d), DELETE em lotes por createdAt (a tabela não é particionada nem append-only). Mesmas guardas (ENABLED/DRY_RUN/piso 30).
  RETENTION_NOTIFICATION_LOG_DAYS: z.coerce.number().int().min(30).default(365),
  // AuditLog — decisão do dono (05/10/2026): 24 MESES (730 d) com purga automática (DELETE em lotes por occurredAt). PISO 730: o trigger append-only do banco só deixa apagar linha com mais de `interval '24 months'`
  // e a rotina ainda se limita a esse corte exato; valor menor que 730 é recusado AQUI (o boot falha, como nos demais RETENTION_*). Pode ser MAIOR (ex.: 1095 = 3 anos). Mesmas guardas: ENABLED/DRY_RUN.
  RETENTION_AUDIT_LOG_DAYS: z.coerce.number().int().min(730).default(730),

  SSE_HEARTBEAT_INTERVAL_SECONDS: z.coerce.number().int().positive().default(25),
  // Teto de streams SSE simultâneos (Órion A2). Por usuário EXPULSA o mais antigo (não tranca quem
  // trocou de rede); por IP e total REJEITAM o novo. Ver `core/realtime/streamLimiter.ts`.
  SSE_MAX_STREAMS_PER_USER: z.coerce.number().int().positive().default(5),
  SSE_MAX_STREAMS_PER_IP: z.coerce.number().int().positive().default(50),
  SSE_MAX_STREAMS_TOTAL: z.coerce.number().int().positive().default(2000),
  DASHBOARD_DIRTY_THROTTLE_MS: z.coerce.number().int().positive().default(5000),
})

export type Env = z.infer<typeof envSchema>

function loadEnv(): Env {
  const parsed = envSchema.safeParse(process.env)
  if (!parsed.success) {
    console.error('[env] configuração inválida:', parsed.error.flatten().fieldErrors)
    process.exit(1)
  }
  // Órion: JWT_SECRET assina TODAS as sessões (HS256) — abaixo de 32 caracteres é fraco demais para
  // um segredo de assinatura. N-12 (Órion, 05/10/2026): em PRODUÇÃO < 32 FALHA o boot (fail-closed, igual ao S-4 dos segredos do
  // webhook) — antes só avisava, e o aviso se perde no stdout. Fora de produção (dev/CI) continua só AVISO e o schema segue aceitando
  // >= 16 (o segredo de dev do docker-compose/.env.example não pode quebrar o ambiente local). Gere com `openssl rand -base64 48`;
  // trocar o segredo derruba todas as sessões abertas (login de novo), e é o preço de sair de um segredo fraco.
  if (parsed.data.NODE_ENV === 'production' && parsed.data.JWT_SECRET.length < 32) {
    console.error(`[env] JWT_SECRET tem ${parsed.data.JWT_SECRET.length} caracteres — em produção exige >= 32 (openssl rand -base64 48). Trocar derruba as sessões abertas.`)
    process.exit(1)
  }
  if (parsed.data.JWT_SECRET.length < 32) {
    console.warn(`[env] AVISO: JWT_SECRET tem ${parsed.data.JWT_SECRET.length} caracteres — recomendado >= 32 (openssl rand -base64 48). Trocar derruba as sessões abertas.`)
  }
  // F5.9: o hold do cartão vencendo ANTES da duração máxima faz o prazo do cartão (encerramento forçado) mandar na sessão e deixa
  // SESSION_MAX_OPEN_HOURS sem efeito para pagamentos em cartão. Só AVISO: configuração incoerente não derruba o boot.
  if (parsed.data.CARD_SESSION_MAX_HOLD_HOURS < parsed.data.SESSION_MAX_OPEN_HOURS) {
    console.warn(
      `[env] AVISO: CARD_SESSION_MAX_HOLD_HOURS (${parsed.data.CARD_SESSION_MAX_HOLD_HOURS}) < SESSION_MAX_OPEN_HOURS (${parsed.data.SESSION_MAX_OPEN_HOURS}) — sessões em cartão serão forçadas a encerrar pelo prazo do hold antes da duração máxima.`,
    )
  }
  // S-4 (auditoria): em PRODUÇÃO o token do caminho e o segredo do header do webhook da Cielo precisam ter >= 32 caracteres. O schema aceita >= 8 para dev/CI (o uso avisa < 32), mas um
  // segredo curto em produção é um webhook adivinhável — fail-closed: não sobe. Ausente continua válido (o token aleatório por processo deixa a rota inalcançável).
  if (parsed.data.NODE_ENV === 'production') {
    for (const [nome, valor] of [['CIELO_WEBHOOK_PATH_TOKEN', parsed.data.CIELO_WEBHOOK_PATH_TOKEN], ['CIELO_WEBHOOK_HEADER_SECRET', parsed.data.CIELO_WEBHOOK_HEADER_SECRET]] as const) {
      if (valor !== undefined && valor.length < 32) {
        console.error(`[env] ${nome} tem ${valor.length} caracteres — em produção exige >= 32 (openssl rand -hex 24).`)
        process.exit(1)
      }
    }
  }
  return parsed.data
}

export const env = loadEnv()
