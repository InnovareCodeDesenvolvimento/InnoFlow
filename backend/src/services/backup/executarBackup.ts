import { randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { BackupDestination } from '@prisma/client'
import { prisma } from '../../lib/prisma'
import { logger } from '../../lib/logger'
import { encryptFile } from '../../lib/crypto/backupCrypto'
import { ErroDeBackup, ehCodigoDeErroDoBackup, type CodigoDeErroDoBackup } from '../../core/backup/erros'
import { decidirPoda, destinoAtivo, clienteMaisVelhoQueOServidor, envDoPgAPartirDaUrl, nomeDoArquivoCifrado, nomeDoDump, tabelasComDados, versaoPrincipalDoPgDump, type DestinoDeBackup } from '../../core/backup/politica'
import { carregarConfigDeBackup, chaveDoBackupDaConfig } from './configBackup'
import { comRetentativa, criarDestinoDaConfig, type DestinoRemoto } from './destinos'
import { criarPastaTemporaria, removerPastaTemporaria, sha256DoArquivo } from './arquivos'
import { PRAZO_DO_PG_RESTORE_LIST_MS, PRAZO_PADRAO_DO_PG_DUMP_MS, ambienteDoFilho, executarComando, type ExecutorDeComando } from './pgFerramentas'
import { tomarTrava } from './trava'

/**
 * Executa o backup: `pg_dump` (formato custom) -> confere o índice -> cifra em fluxo (AES-256-GCM, `docs/BACKUP-FORMATO.md`) -> SHA-256 -> sobe ao destino (com retentativa só para
 * falha de rede) -> poda as cópias além de N -> grava o resultado. Roda no WORKER (a imagem dele tem o cliente do PostgreSQL); a API só enfileira.
 *
 *  - Em QUALQUER desfecho a linha de `BackupRun` fica gravada, com `errorCode` (CÓDIGO, nunca texto livre): o histórico existe para mostrar o que falhou, não só o que deu certo.
 *  - Backup AGENDADO que falha emite o alerta `backup_failed` (CRITICO): é exatamente o caso em que ninguém está olhando. Falha de pedido MANUAL aparece só no histórico/resposta (quem
 *    pediu está na tela).
 *  - Arquivo temporário apagado SEMPRE (pasta própria 0700, removida no `finally`, inclusive em falha/timeout).
 *  - Sem destino completo: o AGENDADO falha (`CONFIG`) — dump que fica no container morre no próximo deploy, é a falsa segurança que este módulo existe para evitar. O MANUAL sem
 *    destino NENHUM ainda vale como TESTE (dumpa, confere e descarta: prova que o `pg_dump` do worker funciona); a rota recusa o manual quando um destino foi ESCOLHIDO e está incompleto.
 *  - Cópia que sai do servidor sai CIFRADA, com a chave própria do backup; sem chave o backup com destino FALHA (`KEY`).
 *  - A retenção só roda DEPOIS do envio confirmado e nunca apaga a única/última cópia (`decidirPoda`). Falha na poda não derruba um backup que já subiu.
 */

export type GatilhoDoBackup = 'SCHEDULED' | 'MANUAL'

export interface DepsDoBackup {
  exec?: ExecutorDeComando
  /** Relógio injetável (nome do arquivo, trava, carimbos). */
  agora?: () => Date
  /** Só teste: troca o destino. `undefined` = o da config; `null` = sem destino (modo teste do dump). */
  destino?: DestinoRemoto | null
  dormir?: (ms: number) => Promise<void>
  databaseUrl?: string
  intervaloDoBatimentoMs?: number
  pastaTemporariaBase?: string
  prazoDoDumpMs?: number
  /** Só teste: chamado depois de criada a pasta temporária e antes do dump (para provar a limpeza em falha). */
  aoCriarPastaTemporaria?: (pasta: string) => void
}

export interface ResultadoDoBackup {
  runId: string
  sizeBytes: number
  tablesWithData: number
  /** Referência no destino, ou `null` se o dump não saiu do servidor (vale como teste, não como backup). */
  objectKey: string | null
  destination: DestinoDeBackup | null
  checksumSha256: string
}

export function paraCodigo(err: unknown): CodigoDeErroDoBackup {
  if (err instanceof ErroDeBackup) return err.codigo
  const c = (err as { codigo?: unknown })?.codigo
  return ehCodigoDeErroDoBackup(c) ? c : 'UNKNOWN'
}

async function conferirVersaoDoCliente(exec: ExecutorDeComando, env: Record<string, string>): Promise<void> {
  const [saida, linhas] = await Promise.all([exec('pg_dump', ['--version'], env, { timeoutMs: 30_000 }), prisma.$queryRaw<Array<{ v: string }>>`SELECT current_setting('server_version_num') AS v`])
  const cliente = versaoPrincipalDoPgDump(saida)
  if (cliente === null) throw new ErroDeBackup('Não consegui ler a versão do pg_dump.', 'DUMP')
  const servidor = Math.floor(Number(linhas[0]?.v ?? 0) / 10000)
  if (clienteMaisVelhoQueOServidor(cliente, servidor)) {
    logger.error({ clientMajor: cliente, serverMajor: servidor }, '[backup] o pg_dump da imagem é mais antigo que o servidor do banco e se recusa a copiar — atualize o postgresql-client do Dockerfile')
    throw new ErroDeBackup('pg_dump mais antigo que o servidor.', 'DUMP')
  }
}

/** Fecha como FALHA o pedido manual (QUEUED) que não chegou a rodar (outra execução já tinha a trava). */
async function fecharPedidoComoFalha(runId: string, codigo: CodigoDeErroDoBackup, agora: Date): Promise<void> {
  await prisma.backupRun.updateMany({ where: { id: runId, status: { in: ['QUEUED', 'RUNNING'] } }, data: { status: 'FAILED', finishedAt: agora, errorCode: codigo } })
}

/**
 * `runId`: pedido manual já criado pela API (QUEUED) — vira RUNNING aqui. Sem `runId` (agendado), cria a linha. Lança `ErroDeBackup` em qualquer falha (a linha já foi gravada).
 */
export async function executarBackup(opcoes: { gatilho: GatilhoDoBackup; runId?: string; criadoPorId?: string | null }, deps: DepsDoBackup = {}): Promise<ResultadoDoBackup> {
  const exec = deps.exec ?? executarComando
  const relogio = deps.agora ?? (() => new Date())
  const inicio = relogio()
  const config = await carregarConfigDeBackup()
  const destinoNome = destinoAtivo(config)
  const databaseUrl = deps.databaseUrl ?? process.env.DATABASE_URL

  const trava = await tomarTrava(inicio, { intervaloDoBatimentoMs: deps.intervaloDoBatimentoMs, relogio })
  if (!trava) {
    if (opcoes.runId) await fecharPedidoComoFalha(opcoes.runId, 'BUSY', relogio())
    throw new ErroDeBackup('Já existe um backup em andamento.', 'BUSY')
  }

  let pasta: string | null = null
  let runId = opcoes.runId ?? ''
  try {
    if (opcoes.runId) {
      const r = await prisma.backupRun.updateMany({ where: { id: opcoes.runId, status: 'QUEUED' }, data: { status: 'RUNNING', startedAt: inicio, destination: destinoNome as BackupDestination | null } })
      if (r.count !== 1) {
        // O pedido já foi fechado (ex.: NOT_PICKED_UP pelo agendador) — não executa um pedido que a tela já deu por perdido.
        throw new ErroDeBackup('O pedido não está mais na fila.', 'NOT_PICKED_UP')
      }
    } else {
      runId = (await prisma.backupRun.create({ data: { trigger: opcoes.gatilho, status: 'RUNNING', destination: destinoNome as BackupDestination | null, createdAt: inicio, startedAt: inicio, createdById: opcoes.criadoPorId ?? null } })).id
    }
  } catch (err) {
    await trava.liberar()
    throw err
  }

  try {
    if (!databaseUrl) throw new ErroDeBackup('DATABASE_URL não está definida: não há o que copiar.', 'CONFIG')
    if (opcoes.gatilho === 'SCHEDULED' && !destinoNome) throw new ErroDeBackup('Backup agendado sem destino completo. Uma cópia que fica no servidor não é backup.', 'CONFIG')

    // Falhar ANTES do dump: destino/segredos/chave legíveis (um dump de gigas gasto à toa é o pior jeito de descobrir JWT_SECRET trocado).
    const remoto = deps.destino !== undefined ? deps.destino : criarDestinoDaConfig(config)
    const chave = remoto ? chaveDoBackupDaConfig(config) : null

    pasta = await criarPastaTemporaria('innoflow-backup-', deps.pastaTemporariaBase)
    deps.aoCriarPastaTemporaria?.(pasta)
    const nomeClaro = nomeDoDump(inicio)
    const arquivo = path.join(pasta, `${randomUUID()}-${nomeClaro}`)
    await fs.writeFile(arquivo, '', { mode: 0o600 })

    let envPg: Record<string, string>
    try {
      envPg = envDoPgAPartirDaUrl(databaseUrl)
    } catch {
      throw new ErroDeBackup('DATABASE_URL inválida.', 'CONFIG')
    }
    const env = ambienteDoFilho(envPg)
    await conferirVersaoDoCliente(exec, env)

    // --no-owner/--no-privileges: o dump precisa voltar num banco novo, com outro usuário dono; sem isso a restauração de emergência falha por causa de um papel que não existe lá.
    // Formato custom (-Fc): já comprimido e permite restaurar UMA tabela.
    await exec('pg_dump', ['--format=custom', '--no-owner', '--no-privileges', `--file=${arquivo}`], env, { timeoutMs: deps.prazoDoDumpMs ?? PRAZO_PADRAO_DO_PG_DUMP_MS })

    // Um dump truncado (disco cheio, conexão caída) existe, tem tamanho e não serve para nada: ler o índice custa um segundo e evita descobrir isso durante um incidente.
    const tabelas = tabelasComDados(await exec('pg_restore', ['--list', arquivo], env, { timeoutMs: PRAZO_DO_PG_RESTORE_LIST_MS }))
    if (tabelas === 0) throw new ErroDeBackup('O dump não tem nenhuma tabela com dados.', 'DUMP')

    // O que sobe é o arquivo CIFRADO; o dump em claro some junto com a pasta temporária.
    let enviar = arquivo
    let nomeFinal = nomeClaro
    if (chave) {
      enviar = `${arquivo}.enc`
      nomeFinal = nomeDoArquivoCifrado(nomeClaro)
      await encryptFile(arquivo, enviar, chave.chave)
    }
    const tamanho = (await fs.stat(enviar)).size
    const sha256 = await sha256DoArquivo(enviar)

    let objectKey: string | null = null
    if (remoto) {
      if (trava.perdida()) throw new ErroDeBackup('A trava do backup foi tomada por outra execução.', 'BUSY')
      objectKey = await comRetentativa(() => remoto.enviar({ arquivo: enviar, nome: nomeFinal, tamanho, sha256 }), { dormir: deps.dormir })
      await podarCopiasAntigas(remoto, config.retentionCount, objectKey)
    }

    const fim = relogio()
    await prisma.$transaction([
      prisma.backupRun.update({
        where: { id: runId },
        data: {
          status: 'SUCCESS',
          finishedAt: fim,
          durationMs: Math.max(0, fim.getTime() - inicio.getTime()),
          fileName: nomeFinal,
          objectKey,
          sizeBytes: BigInt(tamanho),
          checksumSha256: sha256,
          tablesWithData: tabelas,
          encryptionKeyFingerprint: chave?.impressaoDigital ?? null,
        },
      }),
      // `lastSuccessAt` só avança quando o dump SAIU do servidor: o alerta de atraso depende dele, e um teste manual sem destino não pode calar o alerta.
      ...(objectKey ? [prisma.backupConfig.update({ where: { id: 1 }, data: { lastSuccessAt: fim } })] : []),
    ])
    logger.info({ runId, bytes: tamanho, tables: tabelas, destination: remoto?.tipo ?? null, encrypted: chave !== null, durationMs: fim.getTime() - inicio.getTime() }, '[backup] backup concluído')
    return { runId, sizeBytes: tamanho, tablesWithData: tabelas, objectKey, destination: remoto?.tipo ?? null, checksumSha256: sha256 }
  } catch (raw) {
    const codigo = paraCodigo(raw)
    if (!(raw instanceof ErroDeBackup)) logger.error({ err: raw, runId }, '[backup] erro inesperado no backup')
    const fim = relogio()
    await prisma.backupRun
      .updateMany({ where: { id: runId, status: { in: ['QUEUED', 'RUNNING'] } }, data: { status: 'FAILED', finishedAt: fim, durationMs: Math.max(0, fim.getTime() - inicio.getTime()), errorCode: codigo } })
      .catch((e) => logger.error({ err: e }, '[backup] não consegui gravar a falha no histórico'))
    logger.error({ runId, codigo, gatilho: opcoes.gatilho }, '[backup] backup falhou')
    // Backup agendado que falha é exatamente o caso em que ninguém está olhando.
    if (opcoes.gatilho === 'SCHEDULED') {
      logger.error({ alert: 'backup_failed', motivo: codigo, operacao: 'SCHEDULED', escopo: destinoNome ?? 'nenhum' }, '[backup] o backup agendado do banco FALHOU — o banco está sem cópia nova')
    }
    throw raw instanceof ErroDeBackup ? raw : new ErroDeBackup('Erro inesperado no backup.', codigo)
  } finally {
    // Sempre: a trava presa impediria todo backup seguinte, e o arquivo temporário (com TODOS os dados, em claro) não pode ficar no disco.
    await trava.liberar()
    await removerPastaTemporaria(pasta)
  }
}

/** Depois do envio confirmado: apaga as cópias além de N. Nunca derruba o backup (sobrar cópia velha é problema de espaço). */
async function podarCopiasAntigas(remoto: DestinoRemoto, retentionCount: number, objectKeyNovo: string): Promise<void> {
  try {
    const copias = await remoto.listar()
    const novo = copias.find((c) => remoto.referencia(c) === objectKeyNovo)
    // Se o objeto que acabamos de enviar NÃO aparece na listagem (consistência eventual, listagem truncada), não apaga nada: sem confirmação não se poda.
    if (!novo) {
      logger.warn({ quantidade: copias.length }, '[backup] a cópia recém-enviada não apareceu na listagem — poda adiada para o próximo backup')
      return
    }
    const vitimas = decidirPoda(copias, { retentionCount, manter: novo.id })
    if (vitimas.length === 0) return
    const apagadas = await remoto.apagar(vitimas)
    logger.info({ apagadas, mantidas: copias.length - apagadas, retentionCount }, '[backup] cópias antigas apagadas pela retenção')
  } catch (err) {
    logger.warn({ alert: 'backup_prune_failed', motivo: paraCodigo(err), escopo: remoto.tipo }, '[backup] não consegui apagar as cópias antigas (sobraram no destino; confira o espaço)')
  }
}
