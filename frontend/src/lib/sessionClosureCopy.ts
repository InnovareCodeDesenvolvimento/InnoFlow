/**
 * F5.9 (sessão travada) — TODOS os textos de fechamento de sessão num lugar só.
 *
 * Os textos do motorista (D6) podem ser ajustados pelo dono depois: mexa aqui,
 * nunca nos componentes. Este módulo não importa nada (nem `utils`) de
 * propósito — `utils.ts` lê o rótulo do status daqui, e um import de volta
 * criaria ciclo.
 *
 * Os textos com dados variáveis são FUNÇÕES (o horário/valor entra pronto,
 * formatado por quem chama), para o texto inteiro ficar legível num lugar só.
 */

/** Rótulo do status `STOP_UNCONFIRMED` — o mesmo em badge, lista, recibo e relatórios. */
export const STOP_UNCONFIRMED_LABEL = "Encerramento em confirmação"

export const DRIVER_CLOSURE_COPY = {
  /** `time` = `closure.confirmDeadline` em HH:MM no fuso local; ausente => frase sem o prazo (defensivo: o contrato diz que vem preenchido). */
  unconfirmed: (time: string | null) =>
    time
      ? `Encerramento em confirmação com o carregador. Nada foi cobrado ainda. Valor final até ${time}.`
      : "Encerramento em confirmação com o carregador. Nada foi cobrado ainda.",
  /** Só com `paymentMode = "CARD"`; `amount` já formatado em R$. */
  cardHoldKept: (amount: string) => `A pré-autorização de ${amount} continua reservada.`,
  /** `closure.source = "SERVER"` numa sessão `STOPPED`; `time` = `closure.billedUntil` em HH:MM. */
  serverClosed: (time: string | null) =>
    time
      ? `O carregador parou de responder. Cobramos só o que foi medido até ${time}.`
      : "O carregador parou de responder. Cobramos só o que foi medido.",
  /** Sessão `FAULTED` ainda aparecendo como "em andamento" na tela de sessão. */
  faulted: "O carregador informou uma falha nesta recarga. Você pode encerrá-la; cobramos só o que foi medido.",
  /** Recibo aberto de uma sessão que voltou a andar (carregador voltou a medir). */
  reanimated: "O carregador voltou a responder e a recarga continua.",
  reanimatedLink: "Ver a recarga em andamento",
  /** Valor da linha de total/lista enquanto não há valor final. */
  amountPending: "Em confirmação",
} as const

/** Vocabulário do ADMIN (técnico, sem eufemismo). */
export const ADMIN_CLOSURE_COPY = {
  sectionTitle: "Fechamento da sessão",
  lateStopTitle: "StopTransaction tardio",
  lateStopNote: "Informativo: chegou depois de a sessão ser encerrada pelo servidor e NÃO alterou o total cobrado.",
  unconfirmedNote: "Sessão aguardando confirmação do carregador — nenhum valor foi cobrado ainda.",
  fields: {
    unconfirmedReason: "Motivo do não confirmado",
    unconfirmedSince: "Em confirmação desde",
    confirmDeadline: "Prazo de confirmação",
    closureSource: "Fechada por",
    meterStopSource: "Leitura final do medidor",
    billedUntil: "Cobrado até",
    stopRequestedBy: "Parada pedida por",
    stopRequestedAt: "Parada pedida em",
    stopAttempts: "Tentativas de parada",
    lateMeterStopWh: "Leitura do StopTransaction",
    lateStoppedAt: "Parou em",
    lateReceivedAt: "Recebido em",
    lateUnbilledCost: "Custo não cobrado",
  },
} as const
