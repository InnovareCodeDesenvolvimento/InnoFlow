/**
 * Regras puras do backup (`src/core/backup/`): quando é a hora, o que apagar, como ler o `pg_dump`, o que chama atenção, que endereço de bucket é aceito. Sem banco, sem rede.
 */
import { describe, expect, it } from 'vitest'
import {
  ESPERA_ENTRE_TENTATIVAS_MS,
  FOLGA_DE_RECUPERACAO_MS,
  MAX_TENTATIVAS_POR_HORARIO,
  backupAgendadoDevido,
  clienteMaisVelhoQueOServidor,
  conferenciaDevida,
  decidirPoda,
  destinoAtivo,
  ehNomeDeBackup,
  envDoPgAPartirDaUrl,
  inicioDoHorarioMarcado,
  nomeDoArquivoCifrado,
  nomeDoDump,
  proximaExecucaoAgendada,
  situacaoDeAtraso,
  tabelasComDados,
  versaoPrincipalDoPgDump,
  type CopiaNoDestino,
  type HistoricoAgendado,
} from '../../src/core/backup/politica'
import { ErroDeBackup, MENSAGEM_DO_ERRO, CODIGOS_DE_ERRO_DO_BACKUP, mensagemDoErro } from '../../src/core/backup/erros'
import { chaveDoObjeto, enderecoNormalizado, prefixoNormalizado, validarEnderecoS3 } from '../../src/core/backup/enderecoS3'

const h = (n: number) => n * 60 * 60 * 1000
// 03:00 em Brasília = 06:00 UTC.
const utc = (dia: string, hhmm: string) => new Date(`${dia}T${hhmm}:00.000Z`)

describe('horário marcado (Brasília UTC-3, sem horário de verão)', () => {
  it('03h de Brasília é 06h UTC; antes da hora, o "horário marcado mais recente" é o de ontem', () => {
    expect(inicioDoHorarioMarcado(3, utc('2026-10-06', '06:05')).toISOString()).toBe('2026-10-06T06:00:00.000Z')
    expect(inicioDoHorarioMarcado(3, utc('2026-10-06', '05:59')).toISOString()).toBe('2026-10-05T06:00:00.000Z')
  })
  it('hora 22 em Brasília = 01h UTC do dia seguinte (virada de dia)', () => {
    expect(inicioDoHorarioMarcado(22, utc('2026-10-06', '01:30')).toISOString()).toBe('2026-10-06T01:00:00.000Z')
    expect(proximaExecucaoAgendada(22, utc('2026-10-06', '01:30')).toISOString()).toBe('2026-10-07T01:00:00.000Z')
  })
  it('próxima execução: hoje se ainda não passou, amanhã se já passou (e na hora exata, amanhã)', () => {
    expect(proximaExecucaoAgendada(3, utc('2026-10-06', '05:00')).toISOString()).toBe('2026-10-06T06:00:00.000Z')
    expect(proximaExecucaoAgendada(3, utc('2026-10-06', '06:00')).toISOString()).toBe('2026-10-07T06:00:00.000Z')
  })
})

describe('backupAgendadoDevido', () => {
  const cfg = { enabled: true, hourLocal: 3, frequencyDays: 1 }
  const vazio: HistoricoAgendado = { ultimoSucessoAgendadoEm: null, tentativasDesdeOHorario: 0, ultimaTentativaDesdeOHorario: null }

  it('desligado nunca é devido', () => {
    expect(backupAgendadoDevido({ ...cfg, enabled: false }, utc('2026-10-06', '06:10'), vazio)).toBe(false)
  })
  it('é devido depois da hora marcada, sem tentativa hoje', () => {
    expect(backupAgendadoDevido(cfg, utc('2026-10-06', '06:10'), vazio)).toBe(true)
  })
  it('antes da hora marcada de hoje, ainda vale o horário de ONTEM (se dentro da folga de 12 h) — senão não', () => {
    // 05:00 UTC = 02:00 BRT; o horário mais recente foi ontem 06:00 UTC (23 h atrás) => fora da folga => não é devido.
    expect(backupAgendadoDevido(cfg, utc('2026-10-06', '05:00'), vazio)).toBe(false)
  })
  it('processo fora do ar na hora marcada: ainda cobre o dia até 12 h depois, depois disso pula (o alerta de atraso cobre)', () => {
    expect(backupAgendadoDevido(cfg, new Date(utc('2026-10-06', '06:00').getTime() + FOLGA_DE_RECUPERACAO_MS - 60_000), vazio)).toBe(true)
    expect(backupAgendadoDevido(cfg, new Date(utc('2026-10-06', '06:00').getTime() + FOLGA_DE_RECUPERACAO_MS), vazio)).toBe(false)
  })
  it('já houve tentativa bem-sucedida/em andamento neste horário => não repete (nem a cada tick de 10 min)', () => {
    const agora = utc('2026-10-06', '06:20')
    const h1: HistoricoAgendado = { ultimoSucessoAgendadoEm: utc('2026-10-06', '06:00'), tentativasDesdeOHorario: 1, ultimaTentativaDesdeOHorario: { em: utc('2026-10-06', '06:00'), falhou: false } }
    expect(backupAgendadoDevido(cfg, agora, h1)).toBe(false)
    const emAndamento: HistoricoAgendado = { ultimoSucessoAgendadoEm: null, tentativasDesdeOHorario: 1, ultimaTentativaDesdeOHorario: { em: utc('2026-10-06', '06:00'), falhou: false } }
    expect(backupAgendadoDevido(cfg, agora, emAndamento)).toBe(false)
  })
  it('backup MANUAL à tarde NÃO faz pular a madrugada seguinte (só o último SUCESSO AGENDADO conta)', () => {
    // O último sucesso AGENDADO foi ontem 06:00 UTC; hoje 06:10 já é devido, não importa o que o manual fez.
    expect(backupAgendadoDevido(cfg, utc('2026-10-06', '06:10'), { ...vazio, ultimoSucessoAgendadoEm: utc('2026-10-05', '06:00') })).toBe(true)
  })
  it('falha agendada: retenta depois de 1 h, no máximo MAX_TENTATIVAS_POR_HORARIO vezes por horário', () => {
    const t0 = utc('2026-10-06', '06:00')
    const falhou = (n: number, em: Date): HistoricoAgendado => ({ ultimoSucessoAgendadoEm: null, tentativasDesdeOHorario: n, ultimaTentativaDesdeOHorario: { em, falhou: true } })
    expect(backupAgendadoDevido(cfg, new Date(t0.getTime() + 30 * 60_000), falhou(1, t0))).toBe(false) // cedo demais
    expect(backupAgendadoDevido(cfg, new Date(t0.getTime() + ESPERA_ENTRE_TENTATIVAS_MS), falhou(1, t0))).toBe(true)
    const t2 = new Date(t0.getTime() + 2 * ESPERA_ENTRE_TENTATIVAS_MS)
    expect(backupAgendadoDevido(cfg, new Date(t2.getTime() + ESPERA_ENTRE_TENTATIVAS_MS), falhou(MAX_TENTATIVAS_POR_HORARIO, t2))).toBe(false) // teto
  })
  it('frequência de 2 e 7 dias: só devido quando o ciclo venceu desde o último sucesso agendado (tolerância de 2 h)', () => {
    const agora = utc('2026-10-06', '06:10')
    expect(backupAgendadoDevido({ ...cfg, frequencyDays: 2 }, agora, { ...vazio, ultimoSucessoAgendadoEm: utc('2026-10-05', '06:00') })).toBe(false)
    expect(backupAgendadoDevido({ ...cfg, frequencyDays: 2 }, agora, { ...vazio, ultimoSucessoAgendadoEm: utc('2026-10-04', '06:00') })).toBe(true)
    expect(backupAgendadoDevido({ ...cfg, frequencyDays: 7 }, agora, { ...vazio, ultimoSucessoAgendadoEm: utc('2026-10-01', '06:00') })).toBe(false)
    expect(backupAgendadoDevido({ ...cfg, frequencyDays: 7 }, agora, { ...vazio, ultimoSucessoAgendadoEm: utc('2026-09-29', '06:00') })).toBe(true)
  })
})

describe('decidirPoda: mantém N cópias, nunca apaga a nova nem a única/última', () => {
  const c = (id: string, dia: number): CopiaNoDestino => ({ id, criadaEm: new Date(Date.UTC(2026, 9, dia)) })
  it('apaga as mais antigas além de N (contando a recém-enviada)', () => {
    const copias = [c('d1', 1), c('d2', 2), c('d3', 3), c('d4', 4), c('d5', 5)]
    expect(decidirPoda(copias, { retentionCount: 3, manter: 'd5' }).sort()).toEqual(['d1', 'd2'])
    expect(decidirPoda(copias, { retentionCount: 5, manter: 'd5' })).toEqual([])
    expect(decidirPoda(copias, { retentionCount: 7, manter: 'd5' })).toEqual([])
  })
  it('a recém-enviada NUNCA é candidata, mesmo com a data (relógio do destino) dizendo que é a mais velha', () => {
    const copias = [c('novo-com-data-velha', 1), c('d2', 2), c('d3', 3)]
    expect(decidirPoda(copias, { retentionCount: 1, manter: 'novo-com-data-velha' }).sort()).toEqual(['d2', 'd3'])
    expect(decidirPoda(copias, { retentionCount: 2, manter: 'novo-com-data-velha' })).toEqual(['d2'])
  })
  it('retenção 1 deixa só a nova; retenção < 1 é tratada como 1 (nunca "zero cópias")', () => {
    const copias = [c('d1', 1), c('d2', 2), c('d3', 3)]
    expect(decidirPoda(copias, { retentionCount: 1, manter: 'd3' }).sort()).toEqual(['d1', 'd2'])
    expect(decidirPoda(copias, { retentionCount: 0, manter: 'd3' }).sort()).toEqual(['d1', 'd2'])
    expect(decidirPoda(copias, { retentionCount: -5, manter: 'd3' })).not.toContain('d3')
  })
  it('sem `manter` (envio não confirmado) NADA é apagado — nem a única cópia que existe', () => {
    expect(decidirPoda([c('d1', 1), c('d2', 2)], { retentionCount: 1, manter: null })).toEqual([])
    expect(decidirPoda([c('d1', 1)], { retentionCount: 1, manter: null })).toEqual([])
  })
  it('lista com só a recém-enviada => nada a apagar', () => {
    expect(decidirPoda([c('d1', 1)], { retentionCount: 1, manter: 'd1' })).toEqual([])
  })
  it('empate de data desempata pelo id (determinístico)', () => {
    const copias = [c('b', 1), c('a', 1), c('c', 1), c('z', 9)]
    expect(decidirPoda(copias, { retentionCount: 2, manter: 'z' })).toHaveLength(2)
    expect(decidirPoda(copias, { retentionCount: 2, manter: 'z' })).toEqual(decidirPoda([...copias].reverse(), { retentionCount: 2, manter: 'z' }))
  })
})

describe('destinoAtivo: o destino ESCOLHIDO manda, e só vale completo', () => {
  const base = { destination: null, s3Endpoint: null, s3Bucket: null, s3AccessKeyCiphertext: null, s3SecretKeyCiphertext: null, driveOauthRefreshTokenCiphertext: null, driveOauthFolderId: null, driveOauthConnectedAt: null }
  const s3 = { s3Endpoint: 'https://x', s3Bucket: 'b', s3AccessKeyCiphertext: 'v1:a:b', s3SecretKeyCiphertext: 'v1:a:c' }
  const drive = { driveOauthRefreshTokenCiphertext: 'v1:a:b', driveOauthFolderId: 'pasta', driveOauthConnectedAt: new Date() }
  it('sem destino escolhido => null (mesmo com os dois preenchidos)', () => {
    expect(destinoAtivo({ ...base, ...s3, ...drive })).toBeNull()
  })
  it('S3 escolhido e completo; incompleto => null', () => {
    expect(destinoAtivo({ ...base, ...s3, destination: 'S3' })).toBe('S3')
    expect(destinoAtivo({ ...base, ...s3, s3SecretKeyCiphertext: null, destination: 'S3' })).toBeNull()
    expect(destinoAtivo({ ...base, ...s3, s3Bucket: null, destination: 'S3' })).toBeNull()
  })
  it('DRIVE só com a conexão CONCLUÍDA (connectedAt + refresh token + pasta); Client ID preenchido não basta', () => {
    expect(destinoAtivo({ ...base, ...drive, destination: 'DRIVE' })).toBe('DRIVE')
    expect(destinoAtivo({ ...base, ...drive, driveOauthConnectedAt: null, destination: 'DRIVE' })).toBeNull()
    expect(destinoAtivo({ ...base, ...drive, driveOauthRefreshTokenCiphertext: null, destination: 'DRIVE' })).toBeNull()
  })
  it('com os dois completos, vale o escolhido (limpar um campo do outro não muda o destino)', () => {
    expect(destinoAtivo({ ...base, ...s3, ...drive, destination: 'DRIVE' })).toBe('DRIVE')
    expect(destinoAtivo({ ...base, ...s3, ...drive, destination: 'S3' })).toBe('S3')
  })
})

describe('nomes de arquivo', () => {
  it('nome do dump em hora de Brasília, com segundos; cifrado ganha .enc', () => {
    expect(nomeDoDump(utc('2026-10-06', '06:00'))).toBe('backup-innoflow-2026-10-06-03h00m00s.dump')
    expect(nomeDoDump(new Date('2026-10-06T02:30:05.000Z'))).toBe('backup-innoflow-2026-10-05-23h30m05s.dump')
    expect(nomeDoArquivoCifrado('backup-innoflow-2026-10-06-03h00m00s.dump')).toBe('backup-innoflow-2026-10-06-03h00m00s.dump.enc')
  })
  it('só `backup-*.dump` e `backup-*.dump.enc` são NOSSOS (a poda nunca encosta no resto)', () => {
    expect(ehNomeDeBackup('backup-innoflow-2026-10-06-03h00m00s.dump.enc')).toBe(true)
    expect(ehNomeDeBackup('backup-innoflow-2026-10-06-03h00m00s.dump')).toBe(true)
    for (const nome of ['foto.jpg', 'backup-notas.txt', 'meu-backup.dump', '.teste-conexao-ab12.tmp', 'backup-x.dump.enc.bak', '']) expect(ehNomeDeBackup(nome), nome).toBe(false)
  })
})

describe('pg_dump: variáveis de ambiente e versão', () => {
  it('a senha vai em PGPASSWORD (nunca em argv), com percent-decode; sslmode vira PGSSLMODE; parâmetros do Prisma ficam de fora', () => {
    const e = envDoPgAPartirDaUrl('postgresql://usuario:p%40ss%2Fword@db.exemplo.com:5433/innoflow?sslmode=require&schema=public&connection_limit=5')
    expect(e).toEqual({ PGHOST: 'db.exemplo.com', PGPORT: '5433', PGDATABASE: 'innoflow', PGUSER: 'usuario', PGPASSWORD: 'p@ss/word', PGSSLMODE: 'require' })
  })
  it('defaults: porta 5432, sem usuário/senha; URL inválida lança SEM ecoar a URL', () => {
    expect(envDoPgAPartirDaUrl('postgresql://localhost/db')).toEqual({ PGHOST: 'localhost', PGPORT: '5432', PGDATABASE: 'db' })
    try {
      envDoPgAPartirDaUrl('isto não é uma url com senha:segredo123')
      expect.unreachable()
    } catch (e) {
      expect((e as Error).message).not.toContain('segredo123')
    }
  })
  it('versão principal do pg_dump e comparação com o servidor', () => {
    expect(versaoPrincipalDoPgDump('pg_dump (PostgreSQL) 18.1')).toBe(18)
    expect(versaoPrincipalDoPgDump('pg_dump (PostgreSQL) 16.4 (Debian 16.4-1)')).toBe(16)
    expect(versaoPrincipalDoPgDump('lixo')).toBeNull()
    expect(clienteMaisVelhoQueOServidor(16, 18)).toBe(true)
    expect(clienteMaisVelhoQueOServidor(18, 16)).toBe(false)
    expect(clienteMaisVelhoQueOServidor(16, 16)).toBe(false)
    expect(clienteMaisVelhoQueOServidor(16, 0)).toBe(false)
  })
  it('conta as tabelas com dados do índice do pg_restore --list', () => {
    const indice = ['; Archive created', '215; 1259 16385 TABLE public User postgres', '3401; 0 16385 TABLE DATA public User postgres', '3402; 0 16390 TABLE DATA public Site postgres'].join('\n')
    expect(tabelasComDados(indice)).toBe(2)
    expect(tabelasComDados('; so cabecalho')).toBe(0)
  })
})

describe('atraso do backup (backup_stale)', () => {
  const cfg = { enabled: true, enabledAt: utc('2026-10-01', '12:00'), alertAfterHours: 36, lastSuccessAt: null as Date | null }
  it('desligado nunca atrasa', () => {
    expect(situacaoDeAtraso({ ...cfg, enabled: false }, utc('2026-12-01', '12:00')).atrasado).toBe(false)
  })
  it('com sucesso: atrasa quando passa de 36 h (exatamente 36 h ainda não)', () => {
    const ultimo = utc('2026-10-04', '00:00')
    expect(situacaoDeAtraso({ ...cfg, lastSuccessAt: ultimo }, new Date(ultimo.getTime() + h(36))).atrasado).toBe(false)
    const s = situacaoDeAtraso({ ...cfg, lastSuccessAt: ultimo }, new Date(ultimo.getTime() + h(36) + 1))
    expect(s.atrasado).toBe(true)
    expect(s.nuncaRodou).toBe(false)
    expect(s.atrasadoDesde?.toISOString()).toBe(new Date(ultimo.getTime() + h(36)).toISOString())
  })
  it('"nunca rodou": a âncora é QUANDO O AUTOMÁTICO FOI LIGADO (não updatedAt, que a trava renova a cada tentativa)', () => {
    expect(situacaoDeAtraso(cfg, new Date(cfg.enabledAt.getTime() + h(35))).atrasado).toBe(false)
    const s = situacaoDeAtraso(cfg, new Date(cfg.enabledAt.getTime() + h(37)))
    expect(s.atrasado).toBe(true)
    expect(s.nuncaRodou).toBe(true)
  })
  it('sem enabledAt (linha antiga), não alerta de imediato: a âncora cai em "agora"', () => {
    expect(situacaoDeAtraso({ ...cfg, enabledAt: null }, utc('2026-10-06', '12:00')).atrasado).toBe(false)
  })
})

describe('conferência semanal', () => {
  it('devida se nunca rodou ou se a última foi há 7 dias ou mais', () => {
    const agora = utc('2026-10-14', '12:00')
    expect(conferenciaDevida(null, agora)).toBe(true)
    expect(conferenciaDevida(utc('2026-10-08', '12:00'), agora)).toBe(false)
    expect(conferenciaDevida(utc('2026-10-07', '12:00'), agora)).toBe(true)
  })
})

describe('erros como código', () => {
  it('todo código tem mensagem para uma pessoa; código desconhecido cai em UNKNOWN; null passa', () => {
    for (const c of CODIGOS_DE_ERRO_DO_BACKUP) expect(MENSAGEM_DO_ERRO[c].length, c).toBeGreaterThan(20)
    expect(mensagemDoErro('KEY')).toBe(MENSAGEM_DO_ERRO.KEY)
    expect(mensagemDoErro('CODIGO_QUE_NAO_EXISTE')).toBe(MENSAGEM_DO_ERRO.UNKNOWN)
    expect(mensagemDoErro(null)).toBeNull()
    expect(new ErroDeBackup('x', 'DUMP').codigo).toBe('DUMP')
  })
  it('nenhuma mensagem de erro menciona segredo, senha em claro ou stderr', () => {
    for (const c of CODIGOS_DE_ERRO_DO_BACKUP) expect(MENSAGEM_DO_ERRO[c]).not.toMatch(/password=|secret=|postgres:\/\//i)
  })
})

describe('endereço do bucket (anti-SSRF)', () => {
  const prod = { producao: true, permitirRedePrivada: false }
  const dev = { producao: false, permitirRedePrivada: false }
  it('https público passa; é normalizado sem barra no fim', () => {
    const r = validarEnderecoS3('  https://s3.us-east-1.amazonaws.com/ ', prod)
    expect(r.ok).toBe(true)
    if (r.ok) expect(enderecoNormalizado(r.url)).toBe('https://s3.us-east-1.amazonaws.com')
  })
  it('recusa: http em produção, credencial na URL, query/fragmento, URL inválida', () => {
    expect(validarEnderecoS3('http://s3.exemplo.com', prod)).toMatchObject({ ok: false, codigo: 'HTTPS_REQUIRED' })
    expect(validarEnderecoS3('https://user:pass@s3.exemplo.com', prod)).toMatchObject({ ok: false, codigo: 'URL_HAS_CREDENTIALS' })
    expect(validarEnderecoS3('https://s3.exemplo.com/?x=1', prod)).toMatchObject({ ok: false, codigo: 'URL_HAS_EXTRAS' })
    expect(validarEnderecoS3('https://s3.exemplo.com/#frag', prod)).toMatchObject({ ok: false, codigo: 'URL_HAS_EXTRAS' })
    expect(validarEnderecoS3('não é url', prod)).toMatchObject({ ok: false, codigo: 'INVALID_URL' })
  })
  it('recusa metadados de nuvem, loopback e rede privada em produção; metadados SEMPRE, até fora de produção', () => {
    for (const u of ['https://169.254.169.254', 'https://127.0.0.1', 'https://localhost', 'https://10.1.2.3', 'https://192.168.0.5', 'https://minio', 'https://[::1]']) {
      expect(validarEnderecoS3(u, prod).ok, u).toBe(false)
    }
    expect(validarEnderecoS3('http://169.254.169.254', dev).ok).toBe(false)
    expect(validarEnderecoS3('http://127.0.0.1:9000', dev).ok).toBe(true) // desenvolvimento/CI
  })
  it('a permissão do deploy libera http interno SÓ para host de rede privada', () => {
    const lib = { producao: true, permitirRedePrivada: true }
    expect(validarEnderecoS3('http://minio:9000', lib).ok).toBe(true)
    expect(validarEnderecoS3('http://s3.exemplo.com', lib)).toMatchObject({ ok: false, codigo: 'HTTPS_REQUIRED' })
    expect(validarEnderecoS3('http://127.0.0.1:9000', lib).ok).toBe(false)
  })
  it('prefixo: sem barras nas pontas, sem "..", e a chave do objeto monta certo', () => {
    expect(prefixoNormalizado('/inno/flow/')).toBe('inno/flow')
    expect(prefixoNormalizado('../../etc//passwd')).toBe('etc/passwd')
    expect(prefixoNormalizado('a\\b')).toBe('a/b')
    expect(prefixoNormalizado(null)).toBe('')
    expect(chaveDoObjeto('inno', 'x.dump.enc')).toBe('inno/x.dump.enc')
    expect(chaveDoObjeto('', 'x.dump.enc')).toBe('x.dump.enc')
  })
})
