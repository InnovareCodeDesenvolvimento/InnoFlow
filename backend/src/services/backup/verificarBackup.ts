import { randomUUID } from 'node:crypto'
import path from 'node:path'
import type { BackupDestination } from '@prisma/client'
import { prisma } from '../../lib/prisma'
import { logger } from '../../lib/logger'
import { decryptFile, readBackupFileFingerprint } from '../../lib/crypto/backupCrypto'
import { ErroDeBackup } from '../../core/backup/erros'
import { CONFERENCIA_EXPIRA_EM_MS, MARCA_DO_PG_DUMP_CUSTOM, destinoAtivo, tabelasComDados, type DestinoDeBackup } from '../../core/backup/politica'
import { carregarConfigDeBackup, chaveDoBackupDaConfig, erroDeCifraParaBackup } from './configBackup'
import { criarDestinoDaConfig, type CopiaRemota, type DestinoRemoto } from './destinos'
import { criarPastaTemporaria, primeirosBytes, removerPastaTemporaria, sha256DoArquivo } from './arquivos'
import { PRAZO_DO_PG_RESTORE_LIST_MS, ambienteDoFilho, executarComando, type ExecutorDeComando } from './pgFerramentas'
import { paraCodigo } from './executarBackup'
import { promises as fs } from 'node:fs'

/**
 * Conferência da cópia mais recente do destino ("VERIFY"): baixa, confere cabeçalho/impressão digital/SHA-256, decifra POR INTEIRO (a tag do GCM só confere no fim — é ela que prova
 * a integridade) e lê o índice do dump com `pg_restore --list`. NÃO escreve em banco nenhum, nunca restaura em produção: o que a conferência garante é que o arquivo é íntegro e
 * legível com a chave que o sistema tem; que ele restaura num banco novo é o que o teste de ciclo completo e o runbook provam.
 * Fica no histórico como `VERIFY` (não é backup: não mexe em `lastSuccessAt`). Falha agendada emite `backup_verify_failed` (CRITICO); a manual aparece só no histórico/resposta.
 *
 * Contra adulteração no destino: uma cópia MAIS RECENTE sem a marca do formato, com o sistema já usando chave, NÃO passa como "cópia antiga" — pode ser um arquivo trocado (um dump
 * forjado executa SQL no restore). O SHA-256 gravado no envio (BackupRun / metadado do objeto) pega a troca por um arquivo bem formado.
 */

export interface DepsDaConferencia {
  exec?: ExecutorDeComando
  agora?: () => Date
  /** Só teste: troca o destino. */
  destino?: DestinoRemoto | null
  pastaTemporariaBase?: string
}

export interface ResultadoDaConferencia {
  runId: string
  fileName: string
  fileCreatedAt: string
  encrypted: boolean
  keyFingerprint: string | null
  sizeBytes: number
  checksumSha256: string
  tablesWithData: number
  /** `true` = o SHA-256 foi comparado com o gravado no envio; `false` = não havia referência (cópia antiga/banco restaurado): só a integridade do GCM vale. */
  checksumConferido: boolean
}

function maisRecente(copias: CopiaRemota[]): CopiaRemota | null {
  let melhor: CopiaRemota | null = null
  for (const c of copias) {
    if (!melhor || c.criadaEm.getTime() > melhor.criadaEm.getTime() || (c.criadaEm.getTime() === melhor.criadaEm.getTime() && c.id > melhor.id)) melhor = c
  }
  return melhor
}

export async function verificarUltimaCopia(opcoes: { gatilho: 'MANUAL' | 'SCHEDULED'; runId?: string; criadoPorId?: string | null }, deps: DepsDaConferencia = {}): Promise<ResultadoDaConferencia> {
  const exec = deps.exec ?? executarComando
  const relogio = deps.agora ?? (() => new Date())
  const inicio = relogio()
  const config = await carregarConfigDeBackup()
  const destinoNome = destinoAtivo(config)

  // Só uma conferência por vez (sem trava de banco: ela não muda o mundo, só gasta banda).
  const emAndamento = await prisma.backupRun.findFirst({
    where: { trigger: 'VERIFY', status: 'RUNNING', startedAt: { gt: new Date(inicio.getTime() - CONFERENCIA_EXPIRA_EM_MS) }, ...(opcoes.runId ? { id: { not: opcoes.runId } } : {}) },
    select: { id: true },
  })
  if (emAndamento) {
    if (opcoes.runId) await prisma.backupRun.updateMany({ where: { id: opcoes.runId, status: 'QUEUED' }, data: { status: 'FAILED', finishedAt: relogio(), errorCode: 'BUSY' } })
    throw new ErroDeBackup('Já existe uma conferência em andamento.', 'BUSY')
  }

  let runId = opcoes.runId ?? ''
  if (opcoes.runId) {
    const r = await prisma.backupRun.updateMany({ where: { id: opcoes.runId, status: 'QUEUED' }, data: { status: 'RUNNING', startedAt: inicio, destination: destinoNome as BackupDestination | null } })
    if (r.count !== 1) throw new ErroDeBackup('O pedido não está mais na fila.', 'NOT_PICKED_UP')
  } else {
    runId = (await prisma.backupRun.create({ data: { trigger: 'VERIFY', status: 'RUNNING', destination: destinoNome as BackupDestination | null, createdAt: inicio, startedAt: inicio, createdById: opcoes.criadoPorId ?? null } })).id
  }

  let pasta: string | null = null
  try {
    if (!destinoNome) throw new ErroDeBackup('Escolha e complete o destino antes de conferir: é lá que a cópia está.', 'CONFIG')
    const remoto = deps.destino !== undefined && deps.destino !== null ? deps.destino : criarDestinoDaConfig(config)
    if (!remoto) throw new ErroDeBackup('Escolha e complete o destino antes de conferir.', 'CONFIG')

    const ultima = maisRecente(await remoto.listar())
    if (!ultima) throw new ErroDeBackup('O destino ainda não tem nenhuma cópia.', 'NO_BACKUP')
    const ref = remoto.referencia(ultima)

    pasta = await criarPastaTemporaria('innoflow-verify-', deps.pastaTemporariaBase)
    const baixado = path.join(pasta, `${randomUUID()}.download`)
    const { sha256DoMetadado } = await remoto.baixar(ultima, baixado)
    const tamanho = (await fs.stat(baixado)).size
    if (tamanho === 0) throw new ErroDeBackup('A cópia chegou vazia do destino.', 'VERIFY')

    // 1) SHA-256 do que chegou x o que foi gravado no envio (BackupRun desta referência; ou o metadado do objeto).
    const sha256 = await sha256DoArquivo(baixado)
    const envio = await prisma.backupRun.findFirst({ where: { objectKey: ref, status: 'SUCCESS', trigger: { not: 'VERIFY' }, checksumSha256: { not: null } }, orderBy: { createdAt: 'desc' }, select: { checksumSha256: true } })
    const esperado = envio?.checksumSha256 ?? sha256DoMetadado
    if (esperado && esperado !== sha256) throw new ErroDeBackup('O SHA-256 do arquivo baixado não bate com o gravado no envio.', 'CHECKSUM')

    // 2) Cifrada ou não é decidido pelo CABEÇALHO, não pelo nome.
    const impressaoDoArquivo = await readBackupFileFingerprint(baixado)
    let dump = baixado
    let usada: string | null = null
    if (impressaoDoArquivo !== null) {
      const { chave, impressaoDigital } = chaveDoBackupDaConfig(config)
      if (impressaoDoArquivo !== impressaoDigital) {
        throw new ErroDeBackup(`A cópia foi cifrada com a chave ${impressaoDoArquivo}, mas a chave atual do sistema é a ${impressaoDigital}.`, 'KEY')
      }
      dump = path.join(pasta, `${randomUUID()}.dump`)
      try {
        await decryptFile(baixado, dump, chave) // lê o arquivo INTEIRO: a tag do GCM só confere no fim
      } catch (err) {
        throw erroDeCifraParaBackup(err)
      }
      usada = impressaoDigital
    } else if (ultima.nome.endsWith('.enc')) {
      throw new ErroDeBackup('A cópia deveria estar cifrada, mas não tem a marca do formato.', 'VERIFY')
    } else if (config.encryptionKeyCiphertext) {
      // Já existe chave: toda cópia nova nasce cifrada. Uma cópia mais recente SEM a marca pode ser um arquivo trocado no destino.
      throw new ErroDeBackup('A cópia mais recente não está cifrada, mas o backup deste sistema já usa chave.', 'VERIFY')
    }

    // 3) É mesmo um dump do Postgres (formato custom) com tabelas dentro.
    const marca = await primeirosBytes(dump, MARCA_DO_PG_DUMP_CUSTOM.length)
    if (!marca.equals(MARCA_DO_PG_DUMP_CUSTOM)) throw new ErroDeBackup('O conteúdo decifrado não é um dump do PostgreSQL.', 'VERIFY')
    const envDoFilho = ambienteDoFilho({})
    const tabelas = tabelasComDados(await exec('pg_restore', ['--list', dump], envDoFilho, { timeoutMs: PRAZO_DO_PG_RESTORE_LIST_MS }))
    if (tabelas === 0) throw new ErroDeBackup('O índice do dump não lista nenhuma tabela com dados.', 'VERIFY')

    const fim = relogio()
    await prisma.backupRun.update({
      where: { id: runId },
      data: {
        status: 'SUCCESS',
        finishedAt: fim,
        durationMs: Math.max(0, fim.getTime() - inicio.getTime()),
        fileName: ultima.nome,
        objectKey: ref,
        sizeBytes: BigInt(tamanho),
        checksumSha256: sha256,
        tablesWithData: tabelas,
        encryptionKeyFingerprint: usada,
      },
    })
    logger.info({ runId, bytes: tamanho, tables: tabelas, encrypted: usada !== null, checksumConferido: Boolean(esperado) }, '[backup] conferência da cópia mais recente OK')
    return { runId, fileName: ultima.nome, fileCreatedAt: ultima.criadaEm.toISOString(), encrypted: usada !== null, keyFingerprint: usada, sizeBytes: tamanho, checksumSha256: sha256, tablesWithData: tabelas, checksumConferido: Boolean(esperado) }
  } catch (raw) {
    const codigo = paraCodigo(raw)
    if (!(raw instanceof ErroDeBackup)) logger.error({ err: raw, runId }, '[backup] erro inesperado na conferência')
    const fim = relogio()
    await prisma.backupRun
      .updateMany({ where: { id: runId, status: { in: ['QUEUED', 'RUNNING'] } }, data: { status: 'FAILED', finishedAt: fim, durationMs: Math.max(0, fim.getTime() - inicio.getTime()), errorCode: codigo } })
      .catch((e) => logger.error({ err: e }, '[backup] não consegui gravar a falha da conferência'))
    logger.error({ runId, codigo, gatilho: opcoes.gatilho }, '[backup] conferência reprovou')
    if (opcoes.gatilho === 'SCHEDULED') {
      logger.error({ alert: 'backup_verify_failed', motivo: codigo, operacao: 'VERIFY', escopo: (destinoNome ?? 'nenhum') as DestinoDeBackup | 'nenhum' }, '[backup] a conferência semanal da cópia mais recente REPROVOU')
    }
    throw raw instanceof ErroDeBackup ? raw : new ErroDeBackup('Erro inesperado na conferência.', codigo)
  } finally {
    await removerPastaTemporaria(pasta)
  }
}
