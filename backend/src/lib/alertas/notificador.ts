/**
 * Notificador dos alertas ao dono (N-7). Recebe o evento já "cru" (nome do alerta, nível do log, mensagem e objeto logado) e decide, nesta ordem:
 *   severidade -> sanitização -> FILA LIMITADA -> dedupe -> teto por hora -> envio por canal (com prazo).
 * A configuração (canais, destinatários, severidade mínima, dedupe) vem de um SNAPSHOT: estático (`config`+`canais`) ou dinâmico (`provedor`: painel > env, relido a cada
 * poucos segundos; a leitura roda dentro da fila, nunca no chamador).
 *
 * Garantias (testadas):
 *  - `notificar()` é SÍNCRONO, barato e NUNCA lança nem espera I/O: só filtra, sanitiza e enfileira. Todo o resto roda depois, fora do caminho do chamador.
 *  - Fila limitada (`MAX_FILA`) com poucos envios em paralelo: uma tempestade descarta o excesso (contado e logado com gate), não acumula memória nem conexões.
 *  - Nunca gera laço: o log de falha do próprio notificador usa o campo `notifier` (NUNCA `alert`), então o hook do logger o ignora.
 *  - Redis fora => o `DedupeStore` já degrada para memória; qualquer outra exceção aqui é engolida e logada.
 *
 * Sem importar `logger`/`redis` (o logger importa o hook, que importa isto): o log entra por injeção (`log`).
 */
import { chaveDeDedupe, rotuloDaHora, type DedupeStore } from '../../core/alertas/dedupe'
import { sanitizarContexto, sanitizarMensagem } from '../../core/alertas/contexto'
import type { EventoDeAlerta } from '../../core/alertas/formatar'
import { severidadeAtinge, severidadeDoEvento, type SeveridadeNotificacao } from '../../core/alertas/severidade'
import { DeadlineExceededError, withDeadline } from '../withDeadline'
import type { CanalDeAlerta } from './canais'
import type { ConfigAlertas } from './config'

export type LogDoNotificador = (nivel: 'warn' | 'error', dados: Record<string, unknown>, mensagem: string) => void

export interface EventoBruto {
  alerta: string
  /** Nível numérico do pino (30 info, 40 warn, 50 error). */
  nivelPino: number
  mensagem?: unknown
  /** O objeto logado (pode ter qualquer coisa; só a allowlist passa). */
  dados?: unknown
  /** Ignora severidade mínima, dedupe e teto (só o `alerts:test`). */
  forcar?: boolean
}

export type DestinoDoEvento = 'enfileirado' | 'ignorado_severidade' | 'sem_canal' | 'fila_cheia' | 'erro'

/** O que o notificador usa para decidir e enviar: a configuração EFETIVA (painel > env) e os canais montados a partir dela. */
export interface SnapshotDeConfig {
  config: ConfigAlertas
  canais: CanalDeAlerta[]
}

export type ProvedorDeConfig = () => Promise<SnapshotDeConfig>

export interface DepsDoNotificador {
  /** Configuração ESTÁTICA (scripts e testes). Use `config`+`canais` OU `provedor`. */
  config?: ConfigAlertas
  canais?: CanalDeAlerta[]
  /** Configuração DINÂMICA (painel > env), relida a cada `ttlConfigMs`: mudança salva no painel vale em segundos, sem reiniciar. */
  provedor?: ProvedorDeConfig
  ttlConfigMs?: number
  store: DedupeStore
  log: LogDoNotificador
  agora?: () => number
  /** Prazo TOTAL do envio de um evento (todos os canais em paralelo). */
  prazoDeEnvioMs?: number
}

const MAX_FILA = 50
const CONCORRENCIA = 2
const PRAZO_DE_ENVIO_PADRAO_MS = 12_000
const INTERVALO_LOG_DESCARTE_MS = 60_000
const TTL_CONFIG_PADRAO_MS = 5_000
/** Provedor falhou e não há snapshot anterior: espera isto antes de tentar de novo (não martela o banco). */
const BACKOFF_PROVEDOR_MS = 5_000

export class Notificador {
  private readonly fila: Array<() => Promise<void>> = []
  private ativos = 0
  private descartados = 0
  private ultimoLogDescarte = 0
  private readonly ociosos: Array<() => void> = []
  private snapshot: (SnapshotDeConfig & { em: number }) | null = null
  private carregandoConfig: Promise<SnapshotDeConfig | null> | null = null
  private proximaTentativaDoProvedor = 0

  constructor(private readonly deps: DepsDoNotificador) {
    if (deps.config) this.snapshot = { config: deps.config, canais: deps.canais ?? [], em: Number.POSITIVE_INFINITY }
  }

  private agora(): number {
    return (this.deps.agora ?? Date.now)()
  }

  private logSeguro(nivel: 'warn' | 'error', dados: Record<string, unknown>, mensagem: string): void {
    try {
      this.deps.log(nivel, dados, mensagem)
    } catch {
      /* o log do notificador nunca derruba nada */
    }
  }

  /** Canais que aceitam esta severidade (mínimo global E do canal). */
  private canaisPara(snap: SnapshotDeConfig, severidade: SeveridadeNotificacao, forcar: boolean): CanalDeAlerta[] {
    return snap.canais.filter((c) => forcar || (severidadeAtinge(severidade, snap.config.minSeveridade) && severidadeAtinge(severidade, c.minSeveridade)))
  }

  private snapshotFresco(): SnapshotDeConfig | null {
    const s = this.snapshot
    if (!s) return null
    return this.agora() - s.em < (this.deps.ttlConfigMs ?? TTL_CONFIG_PADRAO_MS) ? s : null
  }

  /** Relê a configuração (uma leitura por vez, compartilhada). Falha do provedor: mantém o último snapshot bom (ou nada, se nunca houve). */
  private recarregarConfig(): Promise<SnapshotDeConfig | null> {
    if (this.carregandoConfig) return this.carregandoConfig
    const provedor = this.deps.provedor
    if (!provedor) return Promise.resolve(this.snapshot)
    const p = (async () => {
      if (this.agora() < this.proximaTentativaDoProvedor) return this.snapshot
      try {
        const novo = await provedor()
        this.snapshot = { ...novo, em: this.agora() }
      } catch (err) {
        this.proximaTentativaDoProvedor = this.agora() + BACKOFF_PROVEDOR_MS
        this.logSeguro('warn', { notifier: 'config_indisponivel', erro: err instanceof Error ? err.name : 'erro' }, '[alertas] não consegui ler a configuração de avisos — usando a última conhecida')
      }
      return this.snapshot
    })().finally(() => {
      this.carregandoConfig = null
    })
    this.carregandoConfig = p
    return p
  }

  /** Ponto de entrada (hook do logger). Síncrono, sem I/O, nunca lança. */
  notificar(bruto: EventoBruto): DestinoDoEvento {
    try {
      const emMs = this.agora()
      const fresco = this.snapshotFresco()
      if (fresco) {
        const r = this.preparar(bruto, fresco, emMs)
        return r.executar ? this.enfileirar(r.executar) : r.destino
      }
      // Configuração ainda não lida (ou velha demais): a leitura é I/O, então roda DENTRO da fila — o chamador continua sem esperar nada.
      return this.enfileirar(async () => {
        const snap = await this.recarregarConfig()
        if (!snap) return
        const r = this.preparar(bruto, snap, emMs)
        if (r.executar) await r.executar()
      })
    } catch (err) {
      this.logSeguro('warn', { notifier: 'falha_ao_enfileirar', erro: err instanceof Error ? err.name : 'erro' }, '[alertas] falha ao preparar o aviso ao dono (ignorada)')
      return 'erro'
    }
  }

  /** Decide (severidade x canais) e sanitiza. Sem I/O. */
  private preparar(bruto: EventoBruto, snap: SnapshotDeConfig, emMs: number): { destino: DestinoDoEvento; executar?: () => Promise<void> } {
    const forcar = bruto.forcar === true
    const severidade = severidadeDoEvento(bruto.alerta, bruto.nivelPino)
    const canais = this.canaisPara(snap, severidade, forcar)
    if (canais.length === 0) return { destino: snap.canais.length === 0 ? 'sem_canal' : 'ignorado_severidade' }
    const base: Omit<EventoDeAlerta, 'ocorrenciasSuprimidas' | 'tempestade'> = {
      alerta: bruto.alerta,
      severidade,
      servico: snap.config.servico,
      ambiente: snap.config.ambiente,
      em: new Date(emMs).toISOString(),
      mensagem: sanitizarMensagem(bruto.mensagem),
      contexto: sanitizarContexto(bruto.dados),
    }
    return { destino: 'enfileirado', executar: () => this.processar(base, canais, forcar, snap.config) }
  }

  private enfileirar(tarefa: () => Promise<void>): DestinoDoEvento {
    if (this.fila.length >= MAX_FILA) {
      this.descartados++
      const t = this.agora()
      if (t - this.ultimoLogDescarte >= INTERVALO_LOG_DESCARTE_MS) {
        this.ultimoLogDescarte = t
        this.logSeguro('warn', { notifier: 'fila_cheia', descartadosDesdeOUltimoLog: this.descartados }, '[alertas] fila de avisos cheia — aviso descartado (o alerta continua nos logs)')
        this.descartados = 0
      }
      return 'fila_cheia'
    }
    this.fila.push(tarefa)
    // Fora do caminho do chamador: o primeiro envio só começa depois que o chamador devolver o controle.
    setImmediate(() => this.bombear())
    return 'enfileirado'
  }

  private bombear(): void {
    while (this.ativos < CONCORRENCIA && this.fila.length > 0) {
      const tarefa = this.fila.shift()!
      this.ativos++
      void tarefa()
        .catch((err: unknown) => this.logSeguro('warn', { notifier: 'falha_inesperada', erro: err instanceof Error ? err.name : 'erro' }, '[alertas] falha inesperada ao despachar um aviso (ignorada)'))
        .finally(() => {
          this.ativos--
          this.bombear()
          this.avisarOcioso()
        })
    }
  }

  private avisarOcioso(): void {
    if (this.ativos === 0 && this.fila.length === 0) for (const r of this.ociosos.splice(0)) r()
  }

  /** Resolve quando a fila esvazia e nada está em envio (testes e `alerts:test`). Com limite de tempo: nunca pendura. */
  aguardarOcioso(limiteMs = 15_000): Promise<void> {
    if (this.ativos === 0 && this.fila.length === 0) return Promise.resolve()
    return new Promise((resolve) => {
      const t = setTimeout(resolve, limiteMs)
      t.unref?.()
      this.ociosos.push(() => {
        clearTimeout(t)
        resolve()
      })
    })
  }

  private async processar(base: Omit<EventoDeAlerta, 'ocorrenciasSuprimidas' | 'tempestade'>, canais: CanalDeAlerta[], forcar: boolean, cfg: ConfigAlertas): Promise<void> {
    let suprimidas = 0
    if (!forcar) {
      const ocorrencia = await this.deps.store.registrarOcorrencia(chaveDeDedupe(base.alerta, base.contexto), cfg.dedupeMinutos * 60)
      if (!ocorrencia.avisar) return
      suprimidas = ocorrencia.suprimidas

      const vaga = await this.deps.store.reservarVagaPorHora(base.severidade, rotuloDaHora(this.agora()), cfg.maxPorHora)
      if (vaga === 'silenciado') return
      if (vaga === 'estourou_agora') {
        await this.enviar({ ...base, mensagem: '', contexto: {}, ocorrenciasSuprimidas: 0, tempestade: { limitePorHora: cfg.maxPorHora } }, canais)
        return
      }
    }
    await this.enviar({ ...base, ocorrenciasSuprimidas: suprimidas }, canais)
  }

  private async enviar(evento: EventoDeAlerta, canais: CanalDeAlerta[]): Promise<void> {
    const prazo = this.deps.prazoDeEnvioMs ?? PRAZO_DE_ENVIO_PADRAO_MS
    await Promise.all(
      canais.map(async (canal) => {
        try {
          await withDeadline(canal.enviar(evento), prazo, `envio por ${canal.nome}`)
        } catch (err) {
          // `FalhaDeCanal.motivo` já é seguro; qualquer outro erro vira só o nome (a mensagem crua de uma biblioteca pode embutir host/credencial).
          const motivo = (err as { motivo?: unknown } | null)?.motivo
          this.logSeguro(
            'warn',
            { notifier: 'canal_falhou', canal: canal.nome, motivo: typeof motivo === 'string' ? motivo : err instanceof DeadlineExceededError ? `sem resposta em ${prazo}ms` : err instanceof Error ? err.name : 'erro', alertaDeOrigem: evento.alerta },
            '[alertas] falha ao enviar o aviso ao dono (o alerta continua nos logs)',
          )
        }
      }),
    )
  }
}
