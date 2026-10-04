import {
  Download,
  Gauge,
  History,
  Map as MapIcon,
  MapPinned,
  Network,
  Radio,
  Receipt,
  WalletCards,
  Zap,
  type LucideIcon,
} from "lucide-react"

/**
 * Conteúdo da landing "/" — TODO texto de produto mora aqui, num lugar só, para a auditoria de conteúdo
 * (e o teste `landing-data.test.ts`) olharem uma fonte única.
 *
 * PÚBLICO: o MOTORISTA / usuário do carro elétrico. Nada aqui fala com a empresa que opera eletropostos (painel,
 * relatórios, tarifas do ponto de vista de quem cobra, comandos remotos...): decisão do dono em 04/10/2026.
 *
 * REGRA DE OURO: só se afirma o que o produto FAZ hoje. Cada item leva `proof` = o arquivo/rota do repositório
 * que comprova a afirmação (não aparece na tela; é a trilha para quem for conferir). O pagamento real
 * (Pix/cartão pela Cielo) AINDA NÃO está no ar: toda menção a eles precisa dizer "em breve" (o teste exige).
 * Sem depoimentos, avaliações, números de clientes, preços, prêmios, certificações ou logos de terceiros.
 * NÃO existe filtro "AC/DC" no mapa: o que existe é o tipo e a potência de CADA conector, visíveis em toda parte
 * (e a busca por cidade/endereço + ordenação). Não prometer filtro. Também não há reserva de conector.
 */

export const SITE_URL = "https://innoflow.innovarecode.com.br"
export const SLOGAN = "Carregue um futuro melhor"

export interface NavAnchor {
  href: string
  label: string
}

export const NAV_ANCHORS: NavAnchor[] = [
  { href: "#como-funciona", label: "Como funciona" },
  { href: "#vantagens", label: "Vantagens" },
  { href: "#recursos", label: "Recursos" },
  { href: "#seguranca", label: "Privacidade" },
  { href: "#perguntas", label: "Perguntas" },
]

/** Os três benefícios do hero (a promessa principal está no título e no parágrafo). */
export const HERO_POINTS: Array<{ text: string; proof: string }> = [
  {
    text: "Veja o que está livre agora, com tipo e potência de cada conector",
    proof:
      "frontend/src/lib/stations.ts (STATION_STATE_LABELS 'Livre agora', freeSummaryLabel); components/sites/PublicSiteCard.tsx; lib/utils.ts (CONNECTOR_TYPE_LABELS, formatPowerKw)",
  },
  {
    text: "Confira a tarifa antes de iniciar a recarga",
    proof: "frontend/src/pages/Public/ChargePointLanding.tsx (card do conector: formatTariffHeadlinePrice acima do botão 'Iniciar recarga')",
  },
  {
    text: "Acompanhe e pare a recarga pelo celular",
    proof: "frontend/src/pages/App/Sessao.tsx (kWh, valor estimado, tempo, potência, bateria; 'Parar recarga' com confirmação)",
  },
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
    id: "ao-vivo",
    value: "Ao vivo",
    label: "a sua recarga",
    detail: "kWh, valor estimado, potência e bateria enquanto você carrega",
    proof: "frontend/src/pages/App/Sessao.tsx; components/realtime/RealtimeConnection.tsx (DRIVER assina /api/me/events)",
  },
  {
    id: "sem-loja",
    value: "Sem loja",
    label: "app instalável (PWA)",
    detail: "Abra no navegador do celular e instale na tela inicial se quiser",
    proof: "frontend/vite.config.ts (manifest PWA, display standalone); components/pwa/InstallPromptCard.tsx",
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
    title: "Ache um eletroposto livre",
    text: "Veja os eletropostos da rede com os conectores livres agora, o tipo e a potência de cada um. Busque por cidade ou endereço, veja os mais próximos de você e toque em Como chegar para abrir a rota.",
    proof: "frontend/src/pages/Public/Eletropostos.tsx; pages/App/Mapa.tsx (busca, ordenação, 'Mais próximos'); lib/stations.ts (directionsLinks)",
  },
  {
    id: "qr",
    title: "Escaneie o QR code do carregador",
    text: "Aponte a câmera do celular para o QR code do carregador. A página dele abre direto no navegador, sem instalar nada antes, já com o conector, a potência e a tarifa.",
    proof: "frontend/src/pages/Public/ChargePointLanding.tsx (rota /c/:ocppIdentity); App.tsx",
  },
  {
    id: "iniciar",
    title: "Veja a tarifa e inicie",
    text: "Confira a tarifa e o seu saldo e toque em Iniciar recarga. Se ainda não estiver com a sessão aberta, o app leva ao login e volta para o mesmo carregador. Depois, avisa quando a recarga começar.",
    proof: "frontend/src/pages/Public/ChargePointLanding.tsx (tarifa, 'Seu saldo', redirectTarget); pages/App/Sessao.tsx (estado Conectando)",
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

/** Vantagens: o que muda para o motorista (linguagem de benefício; o "como" está nos recursos logo abaixo). */
export interface Benefit {
  id: string
  icon: LucideIcon
  title: string
  text: string
  /** Onde isso aparece no app (chip curto). */
  where: string
  proof: string
}

export const BENEFITS: Benefit[] = [
  {
    id: "chegar-sabendo",
    icon: MapPinned,
    title: "Chegue sabendo o que esperar",
    text: "Veja se o eletroposto tem conector livre agora, de que tipo e com quanta potência, com o horário da última atualização. Não há reserva: o que aparece é a situação de agora.",
    where: "Mapa e lista",
    proof: "frontend/src/pages/App/Mapa.tsx (comentário 'não existe reserva'); components/estacoes/UpdatedAgo.tsx; lib/stations.ts (stationState)",
  },
  {
    id: "custo-previsivel",
    icon: Receipt,
    title: "Custo sem susto",
    text: "A tarifa aparece antes de você iniciar e, se houver cobrança mínima, o app avisa. Durante a recarga, o valor estimado acompanha o que você consome.",
    where: "Página do carregador",
    proof: "frontend/src/pages/Public/ChargePointLanding.tsx (formatTariffHeadlinePrice, minChargeCents); pages/App/Sessao.tsx (estimatedCostCents, belowMinimum)",
  },
  {
    id: "controle",
    icon: Gauge,
    title: "Controle na palma da mão",
    text: "Inicie, acompanhe energia, tempo, potência e bateria e pare a recarga quando quiser, tudo pelo celular.",
    where: "Tela da recarga",
    proof: "frontend/src/pages/App/Sessao.tsx (Parar recarga + ConfirmDialog)",
  },
  {
    id: "uma-conta",
    icon: Network,
    title: "Uma conta, qualquer operador",
    text: "Um cadastro e uma carteira valem em todos os eletropostos da rede, mesmo que sejam de empresas diferentes. Nada de criar conta nova a cada lugar.",
    where: "Conta e carteira",
    proof: "PROGRESSO.md decisão 9 (conta única de rede); frontend/src/pages/Auth/Register.tsx; types/api.ts",
  },
  {
    id: "historico",
    icon: History,
    title: "Seus gastos à mão",
    text: "Cada recarga vira um recibo com energia, tarifa e detalhamento do custo, guardado no histórico. Dá para conferir depois quanto e onde você carregou.",
    where: "Histórico e recibos",
    proof: "frontend/src/pages/App/Sessoes.tsx ('Histórico de recargas'); pages/App/SessaoDetalhe.tsx ('Detalhamento do custo')",
  },
  {
    id: "sem-loja",
    icon: Download,
    title: "Sem passar pela loja",
    text: "Funciona direto no navegador do celular e pode ser instalado na tela inicial como um app. O QR code abre a página do carregador sem instalar nada.",
    where: "Navegador e tela inicial",
    proof: "frontend/vite.config.ts (manifest PWA); components/pwa/InstallPromptCard.tsx; pages/Public/ChargePointLanding.tsx",
  },
]

/** Recursos do app (bento). `size` define o peso visual na grade (2 "lg" + 4 "md" = duas linhas cheias de 4 colunas). */
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
    title: "Mapa e lista de eletropostos",
    text: "Veja os mais próximos de você ou busque por cidade ou endereço, ordene por distância, quantidade de conectores ou nome, e toque em Como chegar para abrir a rota no Google Maps ou no Waze.",
    size: "lg",
    proof: "frontend/src/pages/App/Mapa.tsx (SORT_OPTIONS, busca); components/estacoes/StationDetailSheet.tsx (Como chegar, Waze); lib/stations.ts (directionsLinks)",
  },
  {
    id: "ac-dc",
    icon: Zap,
    title: "AC e DC com potência",
    text: "AC Tipo 2, DC CCS2 e DC CHAdeMO, sempre com a potência máxima em kW de cada conector.",
    size: "md",
    proof: "frontend/src/lib/utils.ts (CONNECTOR_TYPE_LABELS, formatPowerKw); components/sites/PublicSiteCard.tsx",
  },
  {
    id: "tarifa",
    icon: Receipt,
    title: "Tarifa antes de iniciar",
    text: "O preço por kWh, por minuto ou por sessão, conforme o eletroposto, e o aviso de cobrança mínima aparecem antes de você tocar em Iniciar recarga.",
    size: "md",
    proof: "frontend/src/pages/Public/ChargePointLanding.tsx; lib/utils.ts (formatTariffHeadlinePrice)",
  },
  {
    id: "tempo-real",
    icon: Radio,
    title: "Recarga acompanhada ao vivo",
    text: "Energia em kWh, valor estimado, tempo, potência e bateria atualizados enquanto a recarga acontece, com o botão Parar recarga sempre à mão.",
    size: "lg",
    proof: "frontend/src/pages/App/Sessao.tsx; hooks/useMeSessions.ts (useActiveSession); components/realtime/RealtimeConnection.tsx",
  },
  {
    id: "carteira",
    icon: WalletCards,
    title: "Carteira pré-paga",
    text: "Saldo e extrato num lugar só. A recarga é debitada do saldo da sua carteira.",
    note: "Adicionar saldo por Pix e pagar com cartão: em breve.",
    size: "md",
    proof: "frontend/src/pages/App/Carteira.tsx (Extrato); lib/utils.ts (WALLET_ENTRY_TYPE_LABELS: CHARGE_DEBIT)",
  },
  {
    id: "historico",
    icon: History,
    title: "Histórico e recibos",
    text: "Todas as suas recargas, com energia, tarifa e o detalhamento do custo de cada uma.",
    size: "md",
    proof: "frontend/src/pages/App/Sessoes.tsx; pages/App/SessaoDetalhe.tsx",
  },
]

/** Privacidade e segurança — só o que está implementado e é verificável no código, na ótica de quem usa o app. */
export interface TrustItem {
  id: string
  title: string
  text: string
  proof: string
}

export const TRUST_ITEMS: TrustItem[] = [
  {
    id: "localizacao",
    title: "Sua localização exata não sai do aparelho",
    text: "A busca por eletropostos próximos usa só uma área aproximada. A posição exata não é enviada nem guardada.",
    proof: "frontend/src/components/estacoes/LocationPrompt.tsx; e2e/mapa-eletropostos.spec.ts; .claude/agent-memory/lyra/padrao-mapa-eletropostos-pwa.md",
  },
  {
    id: "offline",
    title: "Saldo e recarga sempre atualizados",
    text: "Dados de saldo e de sessão vêm sempre do servidor: o app não guarda uma cópia antiga no aparelho, então você nunca vê um saldo ou uma recarga desatualizados.",
    proof: "frontend/vite.config.ts (runtimeCaching /api NetworkOnly)",
  },
  {
    id: "extrato",
    title: "Extrato que não se reescreve",
    text: "Lançamentos da carteira não são editados nem apagados: correções entram como novos lançamentos identificados, como Estorno.",
    proof: "PROGRESSO.md (WalletEntry append-only por trigger); frontend/src/lib/utils.ts (WALLET_ENTRY_TYPE_LABELS)",
  },
  {
    id: "login",
    title: "Proteção da sua conta",
    text: "Excesso de tentativas de acesso é bloqueado por um tempo, por conta e por IP.",
    proof: "frontend/src/lib/authErrors.ts (RATE_LIMITED_ACCOUNT_MESSAGE e RATE_LIMITED_AUTH_MESSAGE)",
  },
]

/** Perguntas frequentes do motorista. As respostas seguem a regra de ouro (Pix/cartão = em breve). */
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
    q: "Vejo quanto vai custar antes de começar?",
    a: "Vê a tarifa do conector antes de iniciar (por kWh, por minuto ou por sessão, conforme o eletroposto) e o aviso de cobrança mínima, quando houver. Durante a recarga, o app mostra o valor estimado.",
    proof: "frontend/src/pages/Public/ChargePointLanding.tsx (formatTariffHeadlinePrice, minChargeCents); pages/App/Sessao.tsx (estimatedCostCents)",
  },
  {
    q: "Como pago a recarga?",
    a: "A recarga é debitada do saldo da sua carteira pré-paga no app. O pagamento online por Pix e por cartão de crédito ainda não está disponível e chega em breve.",
    proof: "frontend/src/pages/App/SessaoDetalhe.tsx (walletEntry); pages/App/Sessao.tsx (ConfirmDialog: cobrado da carteira)",
  },
  {
    q: "Posso parar a recarga quando quiser?",
    a: "Pode. Na tela da recarga, toque em Parar recarga e confirme. O recibo mostra a energia entregue e o custo.",
    proof: "frontend/src/pages/App/Sessao.tsx (Parar recarga + ConfirmDialog); pages/App/SessaoDetalhe.tsx",
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
    q: "Quais conectores aparecem?",
    a: "AC Tipo 2, DC CCS2 e DC CHAdeMO. Cada eletroposto informa quais conectores e qual potência oferece, para você escolher o que serve ao seu carro.",
    proof: "frontend/src/lib/utils.ts (CONNECTOR_TYPE_LABELS, formatPowerKw)",
  },
  {
    q: "A InnoFlow guarda a minha localização?",
    a: "Não a posição exata. Para achar eletropostos perto de você, o app usa só uma área aproximada.",
    proof: "frontend/e2e/mapa-eletropostos.spec.ts; components/estacoes/LocationPrompt.tsx",
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
