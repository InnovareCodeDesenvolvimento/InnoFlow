import type { Role } from "@/types/api"
import { TOUR_VERSIONS, type TourId } from "./tourMeta"

export type { TourId } from "./tourMeta"
export { tourIdForRole } from "./tourMeta"

/**
 * ROTEIROS do tour guiado — o ÚNICO arquivo de conteúdo do onboarding. O dono revisa/ajusta o texto aqui; nenhum componente tem frase embutida.
 *
 * Regras de escrita (padrão para todos os sistemas InnoFlow/Innovare):
 *  - pt-BR, primeira pessoa do mascote, frases curtas, sem jargão ("OCPP" só onde a tela usa a palavra);
 *  - SÓ o que existe de fato na tela. Cada passo cita o rótulo real do menu/botão (conferido no código em 05/10/2026);
 *  - `target` liga o passo a `data-tour="..."` de um elemento REAL do SHELL (menu, cabeçalho, barra de navegação), porque as páginas são lazy e podem
 *    não existir quando o tour abre. Alvo ausente/oculto = balão centralizado (fallback), nunca erro;
 *  - mudou o roteiro de forma que valha reexibir? Suba `version` da definição: quem já concluiu a versão antiga vê o tour de novo.
 */

export type TourStepKind = "welcome" | "step" | "finish"

/** O que os textos dinâmicos e os filtros de passo podem saber do momento (papel, largura, itens de menu que o usuário realmente tem). */
export interface TourContext {
  role: Role | undefined
  /** `true` a partir de 1024 px (`lg`): é quando a sidebar do Admin existe. Abaixo disso o menu é um drawer. */
  isWide: boolean
  /** Rotas do menu do usuário (`getAdminNav(role)`): é daqui que sai a regra "OPERATOR não vê passo só-ADMIN". */
  navHrefs: readonly string[]
  navLabels: readonly string[]
  /** Títulos dos grupos do menu ("Operacional", "Financeiro"...), na ordem em que aparecem. */
  navGroups: readonly string[]
}

export interface TourStep {
  id: string
  kind: TourStepKind
  /** Valor de `data-tour` do elemento destacado. Ausente = balão centralizado. */
  target?: string
  /** Alvo alternativo quando a tela é estreita (< 1024 px). */
  targetNarrow?: string
  /** O passo só entra se o menu do usuário tiver esta rota (casa com `adminNav.ts`: o roteiro do OPERATOR é o do ADMIN sem as telas só-ADMIN). */
  requiresNavHref?: string
  /** O passo só existe em tela larga (os itens do menu estão num drawer fechado abaixo de `lg`). */
  wideOnly?: boolean
  /** `happy`: o mascote comemora (olhos felizes + pulinho). */
  mood?: "happy"
  title: string
  body: string | ((ctx: TourContext) => string)
  /** Redação alternativa para tela estreita. */
  bodyNarrow?: string | ((ctx: TourContext) => string)
}

export interface TourDefinition {
  id: TourId
  /** Sobe quando o roteiro muda o bastante para valer reexibir a quem já concluiu a versão anterior. */
  version: number
  /** Nome acessível do diálogo. */
  dialogLabel: string
  steps: readonly TourStep[]
}

export const TOUR_UI = {
  next: "Próximo",
  back: "Voltar",
  skip: "Pular tour",
  start: "Vamos lá",
  finish: "Concluir",
  replay: "Rever tour",
  progress: (current: number, total: number) => `Passo ${current} de ${total}`,
  progressLabel: "Progresso do tour",
} as const

/**
 * FEATURE CHECK dos passos de telas que ainda não existem. Em vez de uma flag manual (que alguém esquece de ligar), o passo declara
 * `requiresNavHref` e só entra quando o menu do usuário já tem a rota — o dia em que a tela de backups entrar no `adminNav.ts`, o passo "Backups" aparece sozinho
 * (o texto dele foi conferido com as seções da tela em 05/10/2026; revisar se a tela mudar).
 */
export const BACKUPS_NAV_HREF = "/admin/backups"

const DRIVER_STEPS: readonly TourStep[] = [
  {
    id: "welcome",
    kind: "welcome",
    title: "Bem-vindo à InnoFlow!",
    body: "Eu sou o Inno, o mascote da InnoFlow. Vou te mostrar o app em poucos passos: onde achar um eletroposto, como iniciar a recarga e onde acompanhar tudo.",
  },
  {
    id: "mapa",
    kind: "step",
    target: "app-nav-mapa",
    title: "Eletropostos perto de você",
    body: "No Mapa você vê a disponibilidade de agora, busca por cidade ou endereço e toca em Como chegar. Se permitir a localização, a lista ordena por distância.",
  },
  {
    id: "qr",
    kind: "step",
    target: "home-qr",
    title: "Carregar é só escanear",
    body: "No carregador, aponte a câmera do celular para o QR code. A página do carregador abre e é só tocar em Iniciar recarga.",
  },
  {
    id: "sessao",
    kind: "step",
    target: "app-nav-sessao",
    title: "Acompanhe a recarga",
    body: "Com a recarga em andamento, esta aba mostra a potência e o andamento, e é aqui que você para a recarga quando quiser. Um pontinho no ícone avisa que há uma recarga ativa.",
  },
  {
    id: "carteira",
    kind: "step",
    target: "app-nav-carteira",
    title: "Sua carteira",
    body: "Veja o saldo e o extrato, adicione saldo por Pix e cadastre um cartão em Meus cartões. Se houver dívida em aberto, é aqui que você a regulariza.",
  },
  {
    id: "historico",
    kind: "step",
    target: "app-nav-sessoes",
    title: "Histórico e recibos",
    body: "Todas as suas recargas ficam aqui. Toque em uma delas para ver o recibo, com o custo detalhado linha a linha.",
  },
  {
    id: "perfil",
    kind: "step",
    target: "app-profile",
    title: "Seu perfil",
    body: "Toque no seu nome para corrigir seus dados e trocar a senha. É lá também que você pode rever este tour.",
  },
  {
    id: "fim",
    kind: "finish",
    mood: "happy",
    title: "Tudo pronto!",
    body: "Boas recargas! Para rever este tour, abra Meu perfil e toque em Rever tour.",
  },
]

const isAdmin = (ctx: TourContext) => ctx.role === "ADMIN"

/** Painel: ADMIN e OPERATOR compartilham a base; o que é só-ADMIN entra por `requiresNavHref` (a mesma regra do menu). */
const PANEL_STEPS: readonly TourStep[] = [
  {
    id: "welcome",
    kind: "welcome",
    title: "Bem-vindo ao painel da InnoFlow!",
    body: (ctx) =>
      "Eu sou o Inno, o mascote da InnoFlow. Vou te mostrar onde fica cada coisa, do cadastro dos carregadores até o dinheiro que entra." +
      (ctx.role === "OPERATOR" ? " Você enxerga só os dados do seu operador." : ""),
  },
  {
    id: "menu",
    kind: "step",
    target: "admin-sidebar",
    targetNarrow: "admin-menu-button",
    title: "O menu do painel",
    body: (ctx) => `Tudo fica agrupado por assunto: ${groupList(ctx)}. Os grupos abrem e fecham com um clique no título.`,
    bodyNarrow: (ctx) => `No celular e no tablet o menu fica neste botão. Nele estão: ${ctx.navLabels.join(", ")}.`,
  },
  {
    id: "dashboard",
    kind: "step",
    target: "nav-dashboard",
    requiresNavHref: "/admin/dashboard",
    wideOnly: true,
    title: "Dashboard e ao vivo",
    body: "Faturamento, sessões, energia e utilização do período, com gráficos. Mais abaixo, o painel Ao vivo mostra as sessões ativas e o status dos carregadores, atualizando a cada 15 segundos.",
  },
  {
    id: "sites",
    kind: "step",
    target: "nav-sites",
    requiresNavHref: "/admin/sites",
    wideOnly: true,
    title: "Sites",
    body: "Comece por aqui: um site é o endereço do eletroposto. Depois você cadastra os pontos de recarga dentro dele.",
  },
  {
    id: "pontos",
    kind: "step",
    target: "nav-charge-points",
    requiresNavHref: "/admin/charge-points",
    wideOnly: true,
    title: "Pontos de recarga",
    body: "Cadastre os carregadores OCPP e acompanhe o status de cada um. No menu de cada linha você dispara comandos remotos.",
  },
  {
    id: "conectores",
    kind: "step",
    target: "nav-connectors",
    requiresNavHref: "/admin/connectors",
    wideOnly: true,
    title: "Conectores",
    body: "As tomadas de cada carregador. Uma tomada pode ter o seu próprio status e, se precisar, a sua própria tarifa.",
  },
  {
    id: "tarifas",
    kind: "step",
    target: "nav-tariffs",
    requiresNavHref: "/admin/tariffs",
    wideOnly: true,
    title: "Tarifas e vínculos",
    body: "Crie a tarifa (preço por kWh, por minuto e taxa de ociosidade) e vincule-a a um local, carregador ou tomada. Sem tarifa válida, o QR não inicia a recarga.",
  },
  {
    id: "sessoes",
    kind: "step",
    target: "nav-sessoes",
    requiresNavHref: "/admin/sessoes",
    wideOnly: true,
    title: "Sessões",
    body: "O analítico de todas as recargas, com filtros e o detalhe de cada sessão.",
  },
  {
    id: "financeiro",
    kind: "step",
    target: "nav-financeiro",
    requiresNavHref: "/admin/financeiro",
    wideOnly: true,
    title: "Financeiro",
    body: "De onde vem o dinheiro: faturamento, cartão, carteira e conciliação. No mesmo grupo ficam Faturamento, Movimento diário, Pagamentos e Carteiras.",
  },
  {
    id: "gateway",
    kind: "step",
    target: "nav-gateway-pagamento",
    requiresNavHref: "/admin/gateway-pagamento",
    wideOnly: true,
    title: "Gateway de pagamento",
    body: "Aqui ficam as credenciais da conta Cielo, o ambiente e os meios de pagamento (cartão e Pix). Os segredos só se gravam: nunca voltam para a tela.",
  },
  {
    id: "comunicacao",
    kind: "step",
    target: "nav-comunicacao",
    requiresNavHref: "/admin/comunicacao",
    wideOnly: true,
    title: "Comunicação",
    body: "Configure por onde você recebe os avisos da operação: e-mail (SMTP) e WhatsApp (Evolution API).",
  },
  {
    // Feature check por rota (`requiresNavHref`): o passo só entra com a tela no menu. Texto conferido com as seções reais da tela em 05/10/2026 (Destino, Chave de criptografia, Agendamento,
    // Ações "Fazer backup agora"/"Conferir backup", Histórico); REVISAR se a tela mudar.
    id: "backups",
    kind: "step",
    target: "nav-backups",
    requiresNavHref: BACKUPS_NAV_HREF,
    wideOnly: true,
    title: "Backups",
    body: "A cópia do banco fora do servidor: escolha o destino, guarde a chave de criptografia, defina o agendamento, faça e confira o backup e veja o histórico.",
  },
  {
    id: "atalhos",
    kind: "step",
    target: "admin-quick-actions",
    title: "Atalhos rápidos",
    body: "No cabeçalho ficam os atalhos do dia a dia, como o dashboard ao vivo, os pontos de recarga, as sessões e o faturamento de hoje.",
  },
  {
    id: "usuario",
    kind: "step",
    target: "admin-user",
    wideOnly: true,
    title: "Seu nome, aqui embaixo",
    body: "Clique no seu nome para rever este tour quando quiser. O botão ao lado é o Sair do painel.",
  },
  {
    id: "fim",
    kind: "finish",
    mood: "happy",
    title: "Tudo pronto!",
    body: (ctx) =>
      "Para rever este tour, clique no seu nome no rodapé do menu (no celular, abra o menu e toque em Rever tour)." +
      (isAdmin(ctx) ? " No Dashboard, o checklist de Primeiros passos mostra o que ainda falta configurar." : ""),
    bodyNarrow: (ctx) =>
      "Para rever este tour, abra o menu e toque em Rever tour." +
      (isAdmin(ctx) ? " No Dashboard, o checklist de Primeiros passos mostra o que ainda falta configurar." : ""),
  },
]

/** "Operacional, Financeiro e Comercial" — só os grupos que o usuário realmente tem (OPERATOR não vê "Rede"). Vem do menu, não de texto fixo. */
function groupList(ctx: TourContext): string {
  const g = ctx.navGroups
  return g.length <= 1 ? g.join("") : `${g.slice(0, -1).join(", ")} e ${g[g.length - 1]}`
}

export const TOUR_DEFINITIONS: Record<TourId, TourDefinition> = {
  driver: { id: "driver", version: TOUR_VERSIONS.driver, dialogLabel: "Tour do aplicativo", steps: DRIVER_STEPS },
  admin: { id: "admin", version: TOUR_VERSIONS.admin, dialogLabel: "Tour do painel administrativo", steps: PANEL_STEPS },
  operator: { id: "operator", version: TOUR_VERSIONS.operator, dialogLabel: "Tour do painel do operador", steps: PANEL_STEPS },
}
