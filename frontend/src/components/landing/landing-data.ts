import {
  Activity,
  BatteryCharging,
  Cpu,
  Landmark,
  LayoutDashboard,
  Map as MapIcon,
  Plug,
  Radio,
  ScrollText,
  Wallet,
  WalletCards,
  Zap,
  type LucideIcon,
} from "lucide-react"

/**
 * Conteúdo da landing "/" — TODO texto de produto mora aqui, num lugar só, para a auditoria de conteúdo
 * (e o teste `landing-data.test.ts`) olharem uma fonte única.
 *
 * REGRA DE OURO: só se afirma o que o produto FAZ hoje. Cada item leva `proof` = o arquivo/rota do repositório
 * que comprova a afirmação (não aparece na tela; é a trilha para quem for conferir). O pagamento real
 * (Pix/cartão pela Cielo) AINDA NÃO está no ar: toda menção a eles precisa dizer "em breve" (o teste exige).
 * Sem depoimentos, avaliações, números de clientes, preços, prêmios, certificações ou logos de terceiros.
 */

export const SITE_URL = "https://innoflow.innovarecode.com.br"
export const SLOGAN = "Carregue um futuro melhor"

export interface NavAnchor {
  href: string
  label: string
}

export const NAV_ANCHORS: NavAnchor[] = [
  { href: "#como-funciona", label: "Como funciona" },
  { href: "#para-quem-opera", label: "Para quem opera" },
  { href: "#recursos", label: "Recursos" },
  { href: "#seguranca", label: "Segurança" },
  { href: "#perguntas", label: "Perguntas" },
]

/** Pontos curtos do hero. */
export const HERO_POINTS: Array<{ text: string; proof: string }> = [
  { text: "AC e DC na mesma busca, com a potência de cada conector", proof: "frontend/src/lib/utils.ts (CONNECTOR_TYPE_LABELS), components/sites/PublicSiteCard.tsx" },
  { text: "Uma conta só para qualquer operador da rede", proof: "PROGRESSO.md decisão 9 (conta única de rede); pages/Public/Home.tsx (antiga)" },
  { text: "Recarga acompanhada em tempo real", proof: "frontend/src/pages/App/Sessao.tsx" },
]

/** Faixa de fatos verificáveis (NÃO são métricas de uso: o produto não publica números de clientes). */
export interface StatFact {
  id: string
  /** Texto grande. Se `count` existir, é animado de 0 até `count`. */
  value: string
  count?: number
  label: string
  detail: string
  proof: string
}

export const STAT_FACTS: StatFact[] = [
  {
    id: "conectores",
    value: "3",
    count: 3,
    label: "tipos de conector",
    detail: "AC Tipo 2, DC CCS2 e DC CHAdeMO",
    proof: "frontend/src/lib/utils.ts (CONNECTOR_TYPE_LABELS)",
  },
  {
    id: "conta",
    value: "1",
    count: 1,
    label: "conta para toda a rede",
    detail: "Cadastre-se uma vez e use em qualquer operador",
    proof: "PROGRESSO.md decisão 9; types/api.ts (User/Wallet sem operatorId)",
  },
  {
    id: "ocpp",
    value: "OCPP 1.6-J",
    label: "protocolo dos carregadores",
    detail: "Comunicação padrão de mercado com o carregador",
    proof: "frontend/src/pages/Admin/ChargePoints/index.tsx (descrição da página)",
  },
  {
    id: "tempo-real",
    value: "Ao vivo",
    label: "status e sessões",
    detail: "Eventos em tempo real para motorista e painel",
    proof: "frontend/src/components/realtime/RealtimeConnection.tsx",
  },
]

/** Etapas do motorista (aba "Como funciona"). `screen` liga ao mockup de celular. */
export type TourScreen = "mapa" | "qr" | "iniciar" | "carregando" | "recibo"

export interface TourStep {
  id: TourScreen
  title: string
  text: string
  proof: string
}

export const TOUR_STEPS: TourStep[] = [
  {
    id: "mapa",
    title: "Ache um eletroposto",
    text: "Veja os eletropostos da rede com conectores livres agora, tipo e potência. No app, o mapa mostra os mais próximos e o botão Como chegar abre a rota.",
    proof: "frontend/src/pages/Public/Eletropostos.tsx; pages/App/Mapa.tsx; components/sites/PublicSiteCard.tsx",
  },
  {
    id: "qr",
    title: "Escaneie o QR code do carregador",
    text: "Aponte a câmera do celular para o QR code do carregador. A página dele abre direto no navegador, sem instalar nada antes.",
    proof: "frontend/src/pages/Public/ChargePointLanding.tsx (rota /c/:ocppIdentity); App.tsx",
  },
  {
    id: "iniciar",
    title: "Inicie a recarga",
    text: "Confira o conector, a tarifa e toque em Iniciar recarga. O app conversa com o carregador e avisa quando a recarga começar.",
    proof: "frontend/src/pages/Public/ChargePointLanding.tsx; pages/App/Sessao.tsx (estado Conectando)",
  },
  {
    id: "carregando",
    title: "Acompanhe em tempo real",
    text: "Energia em kWh, valor estimado, tempo, potência e bateria sendo atualizados enquanto você carrega. Pode parar a recarga quando quiser.",
    proof: "frontend/src/pages/App/Sessao.tsx (kWh, estimatedCostCents, SessionTimer, Potência, Bateria, Parar recarga)",
  },
  {
    id: "recibo",
    title: "Receba o recibo",
    text: "Ao terminar, o recibo mostra energia, tarifa e o detalhamento do custo, e fica guardado no seu histórico de recargas.",
    proof: "frontend/src/pages/App/SessaoDetalhe.tsx; pages/App/Sessoes.tsx",
  },
]

/** Áreas do painel de quem opera. */
export interface OperatorArea {
  id: string
  icon: LucideIcon
  title: string
  text: string
  proof: string
}

export const OPERATOR_AREAS: OperatorArea[] = [
  {
    id: "dashboard",
    icon: LayoutDashboard,
    title: "Dashboard",
    text: "Faturamento, sessões, energia, ticket médio, taxa de sucesso e utilização do período.",
    proof: "frontend/src/pages/Admin/Dashboard/index.tsx (MetricCard x6)",
  },
  {
    id: "sessoes",
    icon: Activity,
    title: "Sessões",
    text: "Acompanhe as recargas em andamento e consulte o histórico detalhado de cada sessão.",
    proof: "frontend/src/components/admin/adminNav.ts (Sessões); pages/Admin/Sessoes/index.tsx",
  },
  {
    id: "financeiro",
    icon: Landmark,
    title: "Financeiro e relatórios",
    text: "Faturamento, movimento diário por eletroposto e pagamentos, com exportação em CSV.",
    proof: "frontend/src/components/admin/adminNav.ts; components/relatorios/ExportCsvButton.tsx",
  },
  {
    id: "tarifas",
    icon: Wallet,
    title: "Tarifas",
    text: "Preço por kWh e por minuto, taxa fixa por sessão, cobrança mínima e taxa de ociosidade.",
    proof: "frontend/src/pages/Admin/Tariffs/TariffFormDialog.tsx",
  },
  {
    id: "carregadores",
    icon: Plug,
    title: "Carregadores e conectores",
    text: "Cadastre pontos de recarga OCPP 1.6-J e seus conectores; reinicie e destrave conectores à distância.",
    proof: "frontend/src/pages/Admin/ChargePoints/index.tsx; components/chargePoints/ChargePointCommandsMenu.tsx",
  },
  {
    id: "carteiras",
    icon: WalletCards,
    title: "Carteiras dos motoristas",
    text: "Consulte o saldo e o extrato dos motoristas. Ajustes de saldo ficam com o administrador da rede.",
    proof: "frontend/src/pages/Admin/Carteiras; components/admin/adminNav.ts",
  },
  {
    id: "auditoria",
    icon: ScrollText,
    title: "Auditoria",
    text: "Registro de quem fez o quê, onde e como, para o administrador da rede.",
    proof: "frontend/src/components/admin/adminNav.ts (Auditoria, ADMIN-only); App.tsx",
  },
  {
    id: "tempo-real",
    icon: Radio,
    title: "Tempo real",
    text: "O painel recebe eventos do servidor e se atualiza sozinho, sem precisar recarregar a página.",
    proof: "frontend/src/components/realtime/RealtimeConnection.tsx (/api/admin/events)",
  },
]

/** Recursos (bento). `size` define o peso visual na grade. */
export interface Feature {
  id: string
  icon: LucideIcon
  title: string
  text: string
  size: "lg" | "md"
  note?: string
  proof: string
}

export const FEATURES: Feature[] = [
  {
    id: "mapa",
    icon: MapIcon,
    title: "Mapa multi-operador",
    text: "Eletropostos de várias empresas numa única rede consultável, com a situação de agora de cada conector. Não há reserva: o que você vê é o estado atual.",
    size: "lg",
    proof: "frontend/src/pages/App/Mapa.tsx (comentário: 'não existe reserva'); pages/Public/Eletropostos.tsx",
  },
  {
    id: "ac-dc",
    icon: Zap,
    title: "AC e DC com potência",
    text: "AC Tipo 2, DC CCS2 e DC CHAdeMO, sempre com a potência máxima em kW de cada conector.",
    size: "md",
    proof: "frontend/src/lib/utils.ts (CONNECTOR_TYPE_LABELS, formatPowerKw)",
  },
  {
    id: "conta-unica",
    icon: BatteryCharging,
    title: "Conta única de rede",
    text: "Um cadastro e uma carteira valem para qualquer operador da plataforma.",
    size: "md",
    proof: "PROGRESSO.md decisão 9; frontend/src/pages/Auth/Register.tsx",
  },
  {
    id: "carteira",
    icon: WalletCards,
    title: "Carteira pré-paga",
    text: "Saldo, extrato e acompanhamento de pendências num lugar só. A recarga é debitada do saldo da carteira.",
    note: "Adicionar saldo por Pix e pagar com cartão: em breve.",
    size: "md",
    proof: "frontend/src/pages/App/Carteira.tsx; lib/utils.ts (WALLET_ENTRY_TYPE_LABELS: CHARGE_DEBIT)",
  },
  {
    id: "tempo-real",
    icon: Radio,
    title: "Acompanhamento em tempo real",
    text: "Energia, valor estimado, tempo, potência e bateria da sua recarga atualizados enquanto ela acontece.",
    size: "md",
    proof: "frontend/src/pages/App/Sessao.tsx",
  },
  {
    id: "ocpp",
    icon: Cpu,
    title: "Protocolo OCPP 1.6-J",
    text: "Os carregadores se conectam à plataforma pelo padrão OCPP 1.6-J, com comandos remotos de reinício e destravamento no painel.",
    size: "lg",
    proof: "frontend/src/pages/Admin/ChargePoints/index.tsx; components/chargePoints/ChargePointCommandsMenu.tsx",
  },
]

/** Segurança e confiança — só o que está implementado e é verificável no código. */
export interface TrustItem {
  id: string
  title: string
  text: string
  proof: string
}

export const TRUST_ITEMS: TrustItem[] = [
  {
    id: "isolamento",
    title: "Dados separados por operador",
    text: "Cada operador enxerga somente os próprios eletropostos e relatórios. Só o administrador da plataforma vê a rede toda.",
    proof: "PROGRESSO.md decisão 1 (multi-tenant com operatorId); frontend/src/lib/utils.ts (operatorContextLabel)",
  },
  {
    id: "perfis",
    title: "Perfis de acesso",
    text: "Motorista, operador e administrador têm telas e permissões diferentes. As áreas restritas também são conferidas no servidor.",
    proof: "frontend/src/App.tsx (RequireAuth roles); components/admin/adminNav.ts (getAdminNav por papel)",
  },
  {
    id: "auditoria",
    title: "Trilha de auditoria",
    text: "As alterações feitas no painel ficam registradas: quem fez, o quê, onde e como.",
    proof: "frontend/src/pages/Admin/Auditoria/index.tsx",
  },
  {
    id: "extrato",
    title: "Extrato que só cresce",
    text: "Lançamentos da carteira não são editados nem apagados: correções entram como novos lançamentos, como Crédito manual ou Estorno.",
    proof: "PROGRESSO.md (WalletEntry append-only por trigger); frontend/src/lib/utils.ts (WALLET_ENTRY_TYPE_LABELS)",
  },
  {
    id: "login",
    title: "Proteção do login",
    text: "Excesso de tentativas de acesso é bloqueado por um tempo, por conta e por IP.",
    proof: "frontend/src/lib/authErrors.ts (RATE_LIMITED_ACCOUNT_MESSAGE e mensagem por IP)",
  },
  {
    id: "localizacao",
    title: "Sua localização exata não sai do aparelho",
    text: "A busca por eletropostos próximos usa só uma área aproximada. A posição exata não é enviada nem guardada.",
    proof: ".claude/agent-memory/lyra/padrao-mapa-eletropostos-pwa.md; frontend/e2e/mapa-eletropostos.spec.ts",
  },
  {
    id: "offline",
    title: "Saldo e sessões nunca ficam em cache",
    text: "Dados financeiros e de sessão sempre vêm do servidor: o app não guarda uma cópia antiga no aparelho.",
    proof: "frontend/vite.config.ts (runtimeCaching /api NetworkOnly)",
  },
]

/** Perguntas frequentes. As respostas seguem a regra de ouro (Pix/cartão = em breve). */
export interface FaqItem {
  q: string
  a: string
  proof: string
}

export const FAQ_ITEMS: FaqItem[] = [
  {
    q: "Preciso baixar um aplicativo?",
    a: "Não é obrigatório. O InnoFlow funciona no navegador do celular. Se preferir, dá para instalá-lo na tela inicial como um app.",
    proof: "frontend/vite.config.ts (manifest PWA); components/pwa/InstallPromptCard.tsx",
  },
  {
    q: "Como começo uma recarga?",
    a: "Escaneie o QR code do carregador com a câmera do celular, entre na sua conta, escolha o conector e toque em Iniciar recarga. Se você ainda não estiver com a sessão aberta, o app leva ao login e volta para o mesmo carregador.",
    proof: "frontend/src/pages/Public/ChargePointLanding.tsx (redirectTarget, handleStart)",
  },
  {
    q: "Como pago a recarga?",
    a: "A recarga é debitada do saldo da sua carteira pré-paga no app. O pagamento online por Pix e por cartão de crédito ainda não está disponível e chega em breve.",
    proof: "frontend/src/pages/App/SessaoDetalhe.tsx (walletEntry); pages/App/Sessao.tsx (ConfirmDialog: cobrado da carteira)",
  },
  {
    q: "Posso carregar em eletropostos de empresas diferentes?",
    a: "Pode. A conta é única de rede: com um cadastro e uma carteira, você usa os eletropostos de qualquer operador da plataforma.",
    proof: "PROGRESSO.md decisão 9",
  },
  {
    q: "O mapa mostra se o carregador está livre?",
    a: "Mostra a situação de agora, com o horário da última atualização. Não existe reserva: um conector livre agora pode estar ocupado quando você chegar.",
    proof: "frontend/src/pages/App/Mapa.tsx (comentário), components/estacoes/UpdatedAgo.tsx",
  },
  {
    q: "Quais conectores são atendidos?",
    a: "AC Tipo 2, DC CCS2 e DC CHAdeMO. Cada eletroposto informa quais conectores e qual potência oferece.",
    proof: "frontend/src/lib/utils.ts (CONNECTOR_TYPE_LABELS)",
  },
  {
    q: "Meus carregadores são compatíveis?",
    a: "A plataforma conversa com carregadores que usam o protocolo OCPP 1.6-J. Confirme com o fabricante se o seu modelo oferece esse protocolo.",
    proof: "frontend/src/pages/Admin/ChargePoints/ChargePointFormDialog.tsx",
  },
  {
    q: "A InnoFlow guarda a minha localização?",
    a: "Não a posição exata. Para achar eletropostos perto de você, o app usa só uma área aproximada.",
    proof: "frontend/e2e/mapa-eletropostos.spec.ts",
  },
]

/** Destinos dos CTAs (rotas que existem em App.tsx). */
export const CTA_LINKS = {
  eletropostos: "/eletropostos",
  cadastro: "/cadastro",
  login: "/login",
} as const

/** Rótulos das telas ilustrativas — repetidos em aria/legenda para ninguém tomar o exemplo por dado real. */
export const EXAMPLE_NOTICE = "Telas ilustrativas, com dados de exemplo."

/** Itens do menu lateral do painel desenhado no mockup (mesmos rótulos de `adminNav.ts`). */
export const ADMIN_MOCK_NAV = ["Dashboard", "Sessões", "Pontos de recarga", "Conectores", "Financeiro", "Carteiras", "Tarifas"] as const
