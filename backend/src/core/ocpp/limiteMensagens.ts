/**
 * Limite de mensagens por conexão do gateway OCPP (N-10 da re-revisão do Órion, 05/10/2026) — regras PURAS (sem rede, sem logger,
 * relógio injetável), testáveis sem subir nada.
 *
 * Por que existe: o `maxPayload` (256 KiB) limita o TAMANHO de uma mensagem, não a QUANTIDADE. Quem tem a senha de um carregador
 * (ou um firmware com defeito) podia mandar milhares de frames por segundo, cada um virando parse + handler + escrita no banco.
 * O `ocpp-rpc` só fecha a conexão por mensagens ruins CONSECUTIVAS (`maxBadMessages`, default Infinity) — e uma enxurrada de
 * mensagens VÁLIDAS (ou de erro intercalado com uma boa, que zera o contador dele) nunca fechava nada.
 *
 * Como foram escolhidos os limites (ritmo real de um carregador OCPP 1.6-J):
 *  - regime normal: Heartbeat a cada 60–300 s; MeterValues a cada 10–60 s por conector (alguns firmwares em depuração mandam 1/s);
 *    StatusNotification esporádico. Mesmo com 2 conectores a 1 s, são ~2 mensagens/s = ~20 numa janela de 10 s.
 *  - rajada legítima: BootNotification + StatusNotification de cada conector (~10 mensagens) e o REPLAY de transações guardadas
 *    offline (StartTransaction/MeterValues/StopTransaction, centenas). O OCPP é pedido-resposta: o carregador espera a resposta de
 *    cada CALL antes do próximo, então o replay anda no ritmo do handler (≥ ~10 ms por mensagem com escrita no banco → ≤ ~100/s).
 *  - teto escolhido: 1000 mensagens em 10 s (100/s sustentado) — 50x o pior regime normal e acima do replay serial mais rápido
 *    plausível; um flood sem esperar resposta (milhares/s) estoura em frações de segundo. Ajustável por env sem deploy de código
 *    (`OCPP_MESSAGE_RATE_MAX` / `OCPP_MESSAGE_RATE_WINDOW_SECONDS`) caso o firmware real (C-P9) peça mais folga.
 *
 * `maxBadMessages = 10`: o `ocpp-rpc` zera o contador a cada mensagem BOA e fecha (1002) ao passar de N RUINS SEGUIDAS
 * (JSON inválido, não-array, tipo desconhecido...). Um firmware com 1–2 frames malformados esporádicos nunca chega perto; 10
 * seguidas é lixo/ataque, não um carregador funcionando.
 */

/** Mensagens ruins CONSECUTIVAS toleradas pelo `ocpp-rpc` antes de fechar a conexão (1002). */
export const OCPP_MAX_BAD_MESSAGES = 10

/** Defaults do limite por conexão (ver o racional acima). */
export const OCPP_MESSAGE_RATE_MAX_DEFAULT = 1000
export const OCPP_MESSAGE_RATE_WINDOW_SECONDS_DEFAULT = 10

/** Código de fechamento WebSocket 1008 = "policy violation". */
export const OCPP_RATE_LIMIT_CLOSE_CODE = 1008
export const OCPP_RATE_LIMIT_CLOSE_REASON = 'message rate limit exceeded'

/** `alert` estruturado (campo do log) do fechamento por excesso de mensagens — para o plantão filtrar. */
export const ALERTA_OCPP_MESSAGE_FLOOD = 'ocpp_message_flood'

/**
 * Janela deslizante EXATA com memória fixa (anel de `max` timestamps): `registrar()` conta uma mensagem e diz se, com ela,
 * houve MAIS de `max` mensagens nos últimos `windowMs`. O anel guarda os `max` instantes mais recentes; a mensagem nº `max + 1`
 * estoura se a mais antiga ainda está dentro da janela. O(1) por mensagem, sem alocação no caminho quente depois de cheio.
 */
export class JanelaDeslizanteMensagens {
  private readonly instantes: number[] = []
  private proximo = 0

  constructor(
    private readonly max: number,
    private readonly windowMs: number,
    private readonly agora: () => number = Date.now,
  ) {
    if (!Number.isInteger(max) || max < 1) throw new Error('max precisa ser um inteiro >= 1')
    if (!Number.isFinite(windowMs) || windowMs <= 0) throw new Error('windowMs precisa ser > 0')
  }

  /** Registra UMA mensagem recebida agora. `true` = excedeu o limite (esta mensagem passou de `max` dentro da janela). */
  registrar(): boolean {
    const agora = this.agora()
    if (this.instantes.length < this.max) {
      this.instantes.push(agora)
      return false
    }
    const maisAntigo = this.instantes[this.proximo]
    const excedeu = agora - maisAntigo < this.windowMs
    this.instantes[this.proximo] = agora
    this.proximo = (this.proximo + 1) % this.max
    return excedeu
  }
}

/** Teto de caracteres de um nome de método ao ir a log: o nome vem do carregador e pode ter centenas de KiB. */
const MAX_METODO_LOG_CHARS = 64

/**
 * O que o handler coringa pode logar de uma chamada sem handler: SÓ o nome da ação (truncado) e o TAMANHO do payload em bytes.
 * NUNCA os `params` — são dados do carregador não validados por nenhum handler (podem ter idTag, números de série, lixo de até
 * 256 KiB), e iam crus para o log de produção (Órion N-10).
 */
export function resumirChamadaSemHandler(method: unknown, params: unknown): { action: string; paramsBytes: number } {
  const nome = typeof method === 'string' ? method : String(method)
  const action = nome.length > MAX_METODO_LOG_CHARS ? `${nome.slice(0, MAX_METODO_LOG_CHARS)}…` : nome
  let paramsBytes = 0
  if (params !== undefined) {
    try {
      paramsBytes = Buffer.byteLength(JSON.stringify(params) ?? '', 'utf8')
    } catch {
      paramsBytes = -1 // não serializável (não acontece com JSON recebido do socket; defensivo)
    }
  }
  return { action, paramsBytes }
}
