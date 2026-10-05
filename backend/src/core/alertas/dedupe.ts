/**
 * Dedupe/throttle dos avisos ao dono. A INTERFACE do armazenamento e a versão em MEMÓRIA ficam aqui (puras, relógio injetável); a versão Redis
 * (compartilhada entre api/ocpp/worker) fica em `lib/alertas/storeRedis.ts`.
 *
 * Duas decisões independentes por evento:
 *  1. `registrarOcorrencia`: a mesma chave (alerta + contexto resumido) avisa no máximo 1x por janela; as repetições são CONTADAS e o número entra no
 *     próximo aviso ("ocorreu mais N vezes").
 *  2. `reservarVagaPorHora`: teto global de avisos por hora (anti-tempestade). Ao estourar, UM aviso "tempestade" e silêncio até a hora virar.
 */
import { createHash } from 'node:crypto'
import type { ValorDeContexto } from './contexto'
import type { SeveridadeNotificacao } from './severidade'

/** Campos que IDENTIFICAM a ocorrência (ficam na chave de dedupe). Contadores e valores variáveis (failures, ageMinutes...) ficam de fora de propósito. */
const CAMPOS_DA_CHAVE = [
  'paymentIntentId', 'intentId', 'paymentId', 'merchantOrderId', 'sessionId', 'chargePointId', 'connectorId', 'userId', 'actorUserId',
  'clientIp', 'ipMascarado', 'motivo', 'escopo', 'operacao', 'returnCode', 'identityKnown', 'envVar',
] as const

export function chaveDeDedupe(alerta: string, contexto: Record<string, ValorDeContexto>): string {
  const partes = CAMPOS_DA_CHAVE.filter((k) => contexto[k] !== undefined).map((k) => `${k}=${String(contexto[k])}`)
  const resumo = createHash('sha1').update(partes.join('|')).digest('hex').slice(0, 16)
  return `${alerta}:${resumo}`
}

export interface ResultadoOcorrencia {
  /** `true` = este é o primeiro da janela: deve avisar. */
  avisar: boolean
  /** Quantas ocorrências foram engolidas desde o último aviso (só significativo quando `avisar`). */
  suprimidas: number
}

export type ResultadoVaga = 'livre' | 'estourou_agora' | 'silenciado'

export interface DedupeStore {
  registrarOcorrencia(chave: string, janelaSegundos: number): Promise<ResultadoOcorrencia>
  reservarVagaPorHora(severidade: SeveridadeNotificacao, hora: string, limite: number): Promise<ResultadoVaga>
}

/** Rótulo da hora corrente (UTC), usado na chave do teto por hora. */
export function rotuloDaHora(agora: number): string {
  return new Date(agora).toISOString().slice(0, 13)
}

/** Decide a vaga a partir do valor do contador (compartilhado por todas as implementações). */
export function resultadoDaVaga(contador: number, limite: number): ResultadoVaga {
  if (contador <= limite) return 'livre'
  return contador === limite + 1 ? 'estourou_agora' : 'silenciado'
}

const MAX_CHAVES_EM_MEMORIA = 1000

/** Implementação em memória do processo: fallback quando o Redis está fora (cada processo dedupa só os seus avisos). */
export class MemoriaDedupeStore implements DedupeStore {
  private readonly janelas = new Map<string, { ate: number; suprimidas: number }>()
  private readonly vagas = new Map<string, number>()

  constructor(private readonly agora: () => number = Date.now) {}

  async registrarOcorrencia(chave: string, janelaSegundos: number): Promise<ResultadoOcorrencia> {
    const t = this.agora()
    const atual = this.janelas.get(chave)
    if (atual && atual.ate > t) {
      atual.suprimidas++
      return { avisar: false, suprimidas: 0 }
    }
    const suprimidas = atual?.suprimidas ?? 0
    this.janelas.set(chave, { ate: t + janelaSegundos * 1000, suprimidas: 0 })
    if (this.janelas.size > MAX_CHAVES_EM_MEMORIA) this.limpar(t)
    return { avisar: true, suprimidas }
  }

  async reservarVagaPorHora(severidade: SeveridadeNotificacao, hora: string, limite: number): Promise<ResultadoVaga> {
    const k = `${severidade}:${hora}`
    const n = (this.vagas.get(k) ?? 0) + 1
    this.vagas.set(k, n)
    if (this.vagas.size > 48) {
      for (const chave of this.vagas.keys()) if (!chave.endsWith(hora)) this.vagas.delete(chave)
    }
    return resultadoDaVaga(n, limite)
  }

  private limpar(t: number): void {
    for (const [k, v] of this.janelas) if (v.ate <= t && v.suprimidas === 0) this.janelas.delete(k)
    // Ainda cheio (muitas chaves vivas): descarta as mais antigas — perder um contador de "ocorreu N vezes" é aceitável, estourar a memória não.
    if (this.janelas.size > MAX_CHAVES_EM_MEMORIA) {
      const excesso = this.janelas.size - MAX_CHAVES_EM_MEMORIA
      let i = 0
      for (const k of this.janelas.keys()) {
        if (i++ >= excesso) break
        this.janelas.delete(k)
      }
    }
  }
}
