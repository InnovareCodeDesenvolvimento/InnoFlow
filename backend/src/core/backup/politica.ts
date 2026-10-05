/**
 * Regras PURAS do backup (sem banco, sem rede, sem env): quando é a hora, o que apagar, como ler o `pg_dump`, o que chama atenção. Porte do `policy.ts` do InnoChat, ajustado
 * ao InnoFlow (retenção em N cópias em vez de dias, frequência em dias, retentativa limitada após falha, alerta de atraso com âncora própria).
 */

export const DESTINOS_DE_BACKUP = ['S3', 'DRIVE'] as const
export type DestinoDeBackup = (typeof DESTINOS_DE_BACKUP)[number]

/** Brasil não tem horário de verão desde 2019: o deslocamento de Brasília é fixo (UTC-3). */
export const BRASILIA_UTC_OFFSET_HOURS = 3
const HORA_MS = 60 * 60 * 1000

/** Trava de execução mais velha que isto é tratada como abandonada (processo morreu no meio). O processo vivo RENOVA a trava a cada `INTERVALO_DO_BATIMENTO_MS`. */
export const TRAVA_EXPIRA_EM_MS = 2 * HORA_MS
export const INTERVALO_DO_BATIMENTO_MS = 5 * 60 * 1000
/** Pedido manual (QUEUED) que o worker não pegou em 15 min: fechado como NOT_PICKED_UP. */
export const PEDIDO_ENFILEIRADO_EXPIRA_EM_MS = 15 * 60 * 1000
/** Se o processo estava fora do ar na hora marcada (deploy, reinício), ainda dá para cobrir o dia até este tempo depois. */
export const FOLGA_DE_RECUPERACAO_MS = 12 * HORA_MS
/** Depois de uma tentativa AGENDADA que falhou, espera isto antes de tentar de novo no mesmo horário marcado; no máximo `MAX_TENTATIVAS_POR_HORARIO` por horário. */
export const ESPERA_ENTRE_TENTATIVAS_MS = 60 * 60 * 1000
export const MAX_TENTATIVAS_POR_HORARIO = 3
/** A conferência automática da cópia mais recente roda no máximo uma vez por semana (tentativa que falhou também conta, para não martelar a cada 10 min). */
export const INTERVALO_DA_CONFERENCIA_MS = 7 * 24 * HORA_MS
/** Conferência que ficou RUNNING além disto morreu no meio. */
export const CONFERENCIA_EXPIRA_EM_MS = 30 * 60 * 1000
/** Intervalo mínimo entre dois alertas `backup_stale`. */
export const INTERVALO_ALERTA_ATRASO_MS = 12 * HORA_MS
/** Frase que a pessoa digita para trocar uma chave que já existe. Trocar é raro e perder a antiga é definitivo. */
export const CONFIRMACAO_TROCAR_CHAVE = 'GERAR NOVA CHAVE'
/** Limite do PutObject simples do S3 (5 GiB): acima disso é preciso multipart. */
export const LIMITE_DO_ENVIO_SIMPLES_BYTES = 5 * 1024 * 1024 * 1024
/** Histórico mais velho que isto é apagado pelo agendador (o histórico existe para investigar, não para guardar para sempre). */
export const RETENCAO_DO_HISTORICO_DIAS = 180

/** O que as regras precisam de `BackupConfig` (estrutural, para não depender do tipo gerado). */
export interface CamposDaConfigDeBackup {
  enabled: boolean
  enabledAt: Date | null
  hourLocal: number
  frequencyDays: number
  retentionCount: number
  alertAfterHours: number
  destination: string | null
  s3Endpoint: string | null
  s3Bucket: string | null
  s3AccessKeyCiphertext: string | null
  s3SecretKeyCiphertext: string | null
  driveOauthRefreshTokenCiphertext: string | null
  driveOauthFolderId: string | null
  driveOauthConnectedAt: Date | null
  lastSuccessAt: Date | null
}

/**
 * Qual destino está ATIVO e completo, ou `null` se o dump não sai do servidor. O destino ESCOLHIDO manda: nunca se infere pelos campos preenchidos (com os dois preenchidos,
 * a dedução escolheria sozinha, e limpar um campo passaria a mudar o destino do backup sem ninguém ter mandado). "Client ID preenchido" NÃO é "conectado": só
 * `driveOauthConnectedAt` prova que o fluxo terminou.
 */
export function destinoAtivo(config: Pick<CamposDaConfigDeBackup, 'destination' | 's3Endpoint' | 's3Bucket' | 's3AccessKeyCiphertext' | 's3SecretKeyCiphertext' | 'driveOauthRefreshTokenCiphertext' | 'driveOauthFolderId' | 'driveOauthConnectedAt'>): DestinoDeBackup | null {
  if (config.destination === 'S3') {
    return config.s3Endpoint && config.s3Bucket && config.s3AccessKeyCiphertext && config.s3SecretKeyCiphertext ? 'S3' : null
  }
  if (config.destination === 'DRIVE') {
    return config.driveOauthConnectedAt && config.driveOauthRefreshTokenCiphertext && config.driveOauthFolderId ? 'DRIVE' : null
  }
  return null
}

const PREFIXO_DO_ARQUIVO = 'backup-'

/** `backup-innoflow-2026-10-06-03h00m05s.dump`, hora de Brasília (a que o dono lê no relógio). Segundos evitam colisão no destino. */
export function nomeDoDump(agora: Date): string {
  const partes = Object.fromEntries(
    new Intl.DateTimeFormat('en-GB', {
      timeZone: 'America/Sao_Paulo',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    })
      .formatToParts(agora)
      .map((p) => [p.type, p.value]),
  )
  return `${PREFIXO_DO_ARQUIVO}innoflow-${partes.year}-${partes.month}-${partes.day}-${partes.hour}h${partes.minute}m${partes.second}s.dump`
}

/** Nome do arquivo cifrado: o do dump + `.enc`. */
export function nomeDoArquivoCifrado(nomeDoDumpEmClaro: string): string {
  return `${nomeDoDumpEmClaro}.enc`
}

/** É nosso arquivo de backup? A retenção e a conferência só tocam no que passa por aqui — qualquer outro arquivo no mesmo bucket/pasta é ignorado. */
export function ehNomeDeBackup(nome: string): boolean {
  return nome.startsWith(PREFIXO_DO_ARQUIVO) && (nome.endsWith('.dump') || nome.endsWith('.dump.enc'))
}

/** A última tentativa de conferência foi há mais de uma semana (ou nunca houve)? */
export function conferenciaDevida(ultimaConferenciaEm: Date | null, agora: Date): boolean {
  return !ultimaConferenciaEm || agora.getTime() - ultimaConferenciaEm.getTime() >= INTERVALO_DA_CONFERENCIA_MS
}

/** Início do horário marcado mais recente que já chegou (hora de Brasília), em UTC. */
export function inicioDoHorarioMarcado(horaLocal: number, agora: Date): Date {
  const horaUtc = (horaLocal + BRASILIA_UTC_OFFSET_HOURS) % 24
  const slot = new Date(Date.UTC(agora.getUTCFullYear(), agora.getUTCMonth(), agora.getUTCDate(), horaUtc, 0, 0, 0))
  if (slot.getTime() > agora.getTime()) slot.setTime(slot.getTime() - 24 * HORA_MS)
  return slot
}

/** Próximo instante em que `horaLocal` (Brasília) acontece depois de `agora`. */
export function proximaExecucaoAgendada(horaLocal: number, agora: Date): Date {
  const horaUtc = (horaLocal + BRASILIA_UTC_OFFSET_HOURS) % 24
  const proxima = new Date(Date.UTC(agora.getUTCFullYear(), agora.getUTCMonth(), agora.getUTCDate(), horaUtc, 0, 0))
  if (proxima.getTime() <= agora.getTime()) proxima.setUTCDate(proxima.getUTCDate() + 1)
  return proxima
}

export interface HistoricoAgendado {
  /** Último SUCESSO de um backup AGENDADO (backup manual não conta: uma cópia manual à tarde não pode fazer o sistema pular a madrugada seguinte — incidente do InnoChat, 2026-10-05). */
  ultimoSucessoAgendadoEm: Date | null
  /** Tentativas AGENDADAS (qualquer resultado) criadas a partir do início do horário marcado de hoje. */
  tentativasDesdeOHorario: number
  /** A tentativa agendada mais recente desse horário FALHOU? (null = não houve tentativa desde o horário.) */
  ultimaTentativaDesdeOHorario: { em: Date; falhou: boolean } | null
}

/**
 * O backup agendado está devido AGORA? Sim quando: o automático está ligado; já passou a hora marcada e ainda estamos dentro da folga de recuperação; o ciclo (frequência em
 * dias, com 2 h de tolerância) venceu desde o último sucesso AGENDADO; e ou não houve tentativa desde o horário, ou a última FALHOU, já passou a espera e não estourou o teto
 * de tentativas daquele horário. Tentativa em andamento/enfileirada conta como tentativa (não duplica) — a trava do banco é a segunda barreira.
 */
export function backupAgendadoDevido(config: Pick<CamposDaConfigDeBackup, 'enabled' | 'hourLocal' | 'frequencyDays'>, agora: Date, historico: HistoricoAgendado): boolean {
  if (!config.enabled) return false
  const horario = inicioDoHorarioMarcado(config.hourLocal, agora)
  if (agora.getTime() - horario.getTime() >= FOLGA_DE_RECUPERACAO_MS) return false
  if (historico.ultimoSucessoAgendadoEm && agora.getTime() - historico.ultimoSucessoAgendadoEm.getTime() < config.frequencyDays * 24 * HORA_MS - 2 * HORA_MS) return false
  const ultima = historico.ultimaTentativaDesdeOHorario
  if (!ultima) return true
  if (!ultima.falhou) return false // tentativa em andamento ou que deu certo neste horário
  if (historico.tentativasDesdeOHorario >= MAX_TENTATIVAS_POR_HORARIO) return false
  return agora.getTime() - ultima.em.getTime() >= ESPERA_ENTRE_TENTATIVAS_MS
}

export interface CopiaNoDestino {
  /** Identificador no destino: a chave do objeto no S3, o id do arquivo no Drive. */
  id: string
  criadaEm: Date
}

/**
 * Decide o que APAGAR do destino depois de um envio confirmado. Mantém as `retentionCount` cópias mais novas, contando a recém-enviada. Guardas que valem mais que a poda:
 *  1. a cópia recém-enviada (`manter`) JAMAIS é candidata (mesmo que a data diga o contrário, ex.: relógio errado do destino);
 *  2. nunca apaga a única/última: com `manter` nulo (o envio novo não foi confirmado) NADA é apagado;
 *  3. `retentionCount < 1` é tratado como 1 (não existe "manter zero cópias").
 * Empate de data desempata pelo id (determinístico).
 */
export function decidirPoda(copias: CopiaNoDestino[], opcoes: { retentionCount: number; manter: string | null }): string[] {
  if (!opcoes.manter) return []
  const quantas = Math.max(1, Math.floor(opcoes.retentionCount))
  const outras = copias.filter((c) => c.id !== opcoes.manter).sort((a, b) => b.criadaEm.getTime() - a.criadaEm.getTime() || (a.id < b.id ? 1 : -1))
  const aManter = quantas - 1 // a recém-enviada ocupa uma vaga
  return outras.slice(aManter).map((c) => c.id)
}

/** Variáveis de ambiente para o `pg_dump`. A senha vai por ENV: argumento de processo é legível por qualquer `ps`. Lança com mensagem SEM a URL (pode ter senha). */
export function envDoPgAPartirDaUrl(databaseUrl: string): Record<string, string> {
  let url: URL
  try {
    url = new URL(databaseUrl)
  } catch {
    throw new Error('DATABASE_URL inválida: não deu para interpretar o endereço do banco.')
  }
  const env: Record<string, string> = {
    PGHOST: url.hostname.replace(/^\[|\]$/g, ''),
    PGPORT: url.port || '5432',
    PGDATABASE: decodeURIComponent(url.pathname.replace(/^\//, '')) || 'postgres',
  }
  if (url.username) env.PGUSER = decodeURIComponent(url.username)
  if (url.password) env.PGPASSWORD = decodeURIComponent(url.password)
  // Banco que exige TLS recusa o pg_dump sem isto, e o erro não diz que o motivo foi o SSL.
  const sslmode = url.searchParams.get('sslmode')
  if (sslmode) env.PGSSLMODE = sslmode
  return env
}

/** Versão principal de "pg_dump (PostgreSQL) 18.1". */
export function versaoPrincipalDoPgDump(saida: string): number | null {
  const m = saida.match(/(\d+)(?:\.\d+)?/)
  return m ? Number(m[1]) : null
}

/** `true` se o cliente da imagem é mais velho que o servidor (o pg_dump se recusa a copiar). */
export function clienteMaisVelhoQueOServidor(cliente: number, servidor: number): boolean {
  return servidor > 0 && cliente < servidor
}

/** Quantas tabelas com dados o índice do dump lista (`pg_restore --list`). */
export function tabelasComDados(indiceDoDump: string): number {
  return (indiceDoDump.match(/TABLE DATA/g) ?? []).length
}

/** O dump no formato custom começa com estes 5 bytes. */
export const MARCA_DO_PG_DUMP_CUSTOM = Buffer.from('PGDMP', 'latin1')

export interface SituacaoDeAtraso {
  atrasado: boolean
  nuncaRodou: boolean
  idadeEmHoras: number | null
  atrasadoDesde: Date | null
}

/**
 * Backup atrasado? Só vale com o automático ligado. "Nunca rodou" conta como atrasado quando o limite passou desde que o automático foi LIGADO (`enabledAt`), para não alertar no
 * minuto em que alguém liga o agendamento. (O InnoChat usava `updatedAt`, que o Prisma renova até a cada trava/tentativa — a âncora nunca chegaria no limite.)
 */
export function situacaoDeAtraso(config: Pick<CamposDaConfigDeBackup, 'enabled' | 'enabledAt' | 'alertAfterHours' | 'lastSuccessAt'>, agora: Date): SituacaoDeAtraso {
  if (!config.enabled) return { atrasado: false, nuncaRodou: false, idadeEmHoras: null, atrasadoDesde: null }
  const limiteMs = config.alertAfterHours * HORA_MS
  if (config.lastSuccessAt) {
    const idade = agora.getTime() - config.lastSuccessAt.getTime()
    return {
      atrasado: idade > limiteMs,
      nuncaRodou: false,
      idadeEmHoras: Math.floor(idade / HORA_MS),
      atrasadoDesde: idade > limiteMs ? new Date(config.lastSuccessAt.getTime() + limiteMs) : null,
    }
  }
  const ancora = config.enabledAt ?? agora
  const atrasado = agora.getTime() - ancora.getTime() > limiteMs
  return { atrasado, nuncaRodou: true, idadeEmHoras: null, atrasadoDesde: atrasado ? new Date(ancora.getTime() + limiteMs) : null }
}
