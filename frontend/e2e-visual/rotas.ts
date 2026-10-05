import type { Persona } from "./constantes"

export interface Rota {
  /** Identificador estável: vira nome do arquivo de baseline (`<id>.jpg`) — NÃO renomeie sem mover a baseline. */
  id: string
  path: string
  persona: Persona
  /** Texto/role que prova que a tela terminou de carregar (além do "sem esqueleto/spinner" genérico). */
  pronto?: { heading?: string; text?: string }
  /** Telas com bottom nav `fixed` e altura própria (PWA): a foto cresce até o fim do documento (ver `fotografar`). */
  crescerAteODocumento?: boolean
  /** Telas com o card escuro "brand" + rosto do mascote: ruído de rasterização NÃO determinístico (ver `playwright.visual.config.ts`). Tolera 0,4% de pixels (a sonda de geometria é a régua precisa). */
  ruidoRaster?: boolean
}

/**
 * Catálogo das rotas fotografadas — as do §1.3 da auditoria (`docs/DESIGN-SYSTEM-UNIFICACAO.md`), com `/app/sessoes/:id`
 * (recibo) tornado capturável pelos recibos PRÉ-SEMEADOS do motorista `travado@` (F5.9, `src/mocks/meData.ts`). O recibo "Recarga
 * concluída" e a sessão ao vivo saem do fluxo real em `estados.visual.ts`.
 */
export const ROTAS: Rota[] = [
  // ---- público e auth ----
  { id: "pub-landing", path: "/", persona: "anon" },
  { id: "pub-eletropostos", path: "/eletropostos", persona: "anon", pronto: { heading: "Eletropostos" } },
  { id: "auth-login", path: "/login", persona: "anon" },
  { id: "auth-cadastro", path: "/cadastro", persona: "anon" },
  { id: "pub-qr-carregador", path: "/c/CP-VILA-NORTE-01", persona: "anon" },
  { id: "pub-qr-conector", path: "/c/CP-VILA-NORTE-01/1", persona: "anon" },
  // Documento isolado do cartão aberto direto na URL: estado "sem janela de origem" (o formulário pronto sai de `estados.visual.ts`).
  { id: "pub-cartao-isolado-sem-opener", path: "/pagamento-cartao.html", persona: "anon" },
  // Hoje redireciona para "/" (T5 da auditoria; a D5 pode mudar isso — a baseline vai acusar, de propósito).
  { id: "pub-rota-inexistente", path: "/nao-existe-xyz", persona: "anon" },

  // ---- PWA do motorista (motorista@) ----
  { id: "pwa-inicio", path: "/app", persona: "driver", crescerAteODocumento: true },
  { id: "pwa-sessao-vazia", path: "/app/sessao", persona: "driver", crescerAteODocumento: true, ruidoRaster: true },
  { id: "pwa-historico-vazio", path: "/app/sessoes", persona: "driver", crescerAteODocumento: true, ruidoRaster: true },
  { id: "pwa-mapa", path: "/app/mapa", persona: "driver" },
  { id: "pwa-carteira", path: "/app/carteira", persona: "driver", crescerAteODocumento: true },
  { id: "pwa-carteira-adicionar", path: "/app/carteira/adicionar", persona: "driver", crescerAteODocumento: true, ruidoRaster: true },
  { id: "pwa-cartoes", path: "/app/carteira/cartoes", persona: "driver", crescerAteODocumento: true, ruidoRaster: true },

  // ---- PWA do motorista com histórico e sessão travada (travado@) ----
  { id: "pwa-travado-historico", path: "/app/sessoes", persona: "travado", crescerAteODocumento: true },
  { id: "pwa-travado-sessao-faulted", path: "/app/sessao", persona: "travado", crescerAteODocumento: true },
  { id: "pwa-recibo-fechada-pelo-servidor", path: "/app/sessoes/me_seed_server_closed", persona: "travado", crescerAteODocumento: true },
  { id: "pwa-recibo-stop-nao-confirmado-carteira", path: "/app/sessoes/me_seed_unconfirmed_wallet", persona: "travado", crescerAteODocumento: true },
  { id: "pwa-recibo-stop-nao-confirmado-cartao", path: "/app/sessoes/me_seed_unconfirmed_card", persona: "travado", crescerAteODocumento: true },

  // ---- Admin (admin@ — vê as rotas ADMIN-only) ----
  { id: "adm-dashboard", path: "/admin/dashboard", persona: "admin" },
  { id: "adm-financeiro", path: "/admin/financeiro", persona: "admin" },
  { id: "adm-movimento-diario", path: "/admin/movimento-diario", persona: "admin" },
  { id: "adm-faturamento", path: "/admin/faturamento", persona: "admin" },
  { id: "adm-sessoes", path: "/admin/sessoes", persona: "admin" },
  { id: "adm-pagamentos", path: "/admin/pagamentos", persona: "admin" },
  { id: "adm-carteiras", path: "/admin/carteiras", persona: "admin" },
  { id: "adm-sites", path: "/admin/sites", persona: "admin" },
  { id: "adm-charge-points", path: "/admin/charge-points", persona: "admin" },
  { id: "adm-connectors", path: "/admin/connectors", persona: "admin" },
  { id: "adm-tariffs", path: "/admin/tariffs", persona: "admin" },
  { id: "adm-auth-tokens", path: "/admin/auth-tokens", persona: "admin" },
  { id: "adm-gateway-pagamento", path: "/admin/gateway-pagamento", persona: "admin" },
  { id: "adm-auditoria", path: "/admin/auditoria", persona: "admin" },
]
