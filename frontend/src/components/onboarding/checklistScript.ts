/**
 * Textos do checklist "Primeiros passos" do Dashboard do ADMIN. Mesmas regras de `tourScripts.ts`: só o que existe na tela, rótulos reais, pt-BR.
 * A ORDEM é a ordem natural de montar uma operação (cada item depende do anterior). `key` liga o item ao dado que o marca como feito (`checklistLogic.ts`).
 */

export type ChecklistKey = "site" | "chargePoint" | "connector" | "tariff" | "assignment" | "gateway" | "communication"

export interface ChecklistItemScript {
  key: ChecklistKey
  title: string
  description: string
  /** Rota do painel onde o item se resolve. */
  href: string
  cta: string
}

export const CHECKLIST_ITEMS: readonly ChecklistItemScript[] = [
  { key: "site", title: "Cadastrar um site", description: "O endereço do eletroposto.", href: "/admin/sites", cta: "Cadastrar" },
  { key: "chargePoint", title: "Cadastrar um ponto de recarga", description: "O carregador OCPP que fica no site.", href: "/admin/charge-points", cta: "Cadastrar" },
  { key: "connector", title: "Cadastrar os conectores", description: "As tomadas do carregador.", href: "/admin/connectors", cta: "Cadastrar" },
  { key: "tariff", title: "Criar uma tarifa", description: "Preço por kWh, por minuto e taxa de ociosidade.", href: "/admin/tariffs", cta: "Criar" },
  { key: "assignment", title: "Vincular a tarifa", description: "Sem tarifa válida, o QR não inicia a recarga.", href: "/admin/tariffs", cta: "Vincular" },
  { key: "gateway", title: "Configurar o gateway de pagamento", description: "Para cobrar por Pix e cartão.", href: "/admin/gateway-pagamento", cta: "Configurar" },
  { key: "communication", title: "Configurar os avisos", description: "E-mail ou WhatsApp para os alertas da operação.", href: "/admin/configuracoes/email", cta: "Configurar" },
]

export const CHECKLIST_UI = {
  title: "Primeiros passos",
  intro: "Vamos deixar a operação pronta para receber o primeiro motorista.",
  progress: (done: number, total: number) => `${done} de ${total} passos`,
  done: "Feito",
  dismiss: "Dispensar",
  dismissLabel: "Dispensar o checklist de Primeiros passos",
  dismissed: "Checklist dispensado. Você pode rever o tour pelo menu.",
  replayTour: "Rever tour",
} as const
