import { createReadStream, createWriteStream } from 'node:fs'
import dns from 'node:dns'
import http from 'node:http'
import https from 'node:https'
import { pipeline } from 'node:stream/promises'
import type { Readable } from 'node:stream'
import { randomUUID } from 'node:crypto'
import { DeleteObjectCommand, DeleteObjectsCommand, GetObjectCommand, ListObjectsV2Command, PutObjectCommand, S3Client } from '@aws-sdk/client-s3'
import { logger } from '../logger'
import { limparTextoSensivel } from '../logSerializers'
import { ErroDeBackup } from '../../core/backup/erros'
import { chaveDoObjeto, prefixoNormalizado, validarEnderecoS3 } from '../../core/backup/enderecoS3'
import { LIMITE_DO_ENVIO_SIMPLES_BYTES, ehNomeDeBackup, type CopiaNoDestino } from '../../core/backup/politica'
import { validarHostDeclarado, type PoliticaDeDestino } from '../../core/comunicacao/destinoSeguro'

/**
 * Cliente do destino S3-compatível (AWS S3, Cloudflare R2, Backblaze B2, MinIO...). DECISÃO DE DEPENDÊNCIA: `@aws-sdk/client-s3` em vez de assinar SigV4 à mão. A assinatura cabe em
 * ~150 linhas, mas o que importa aqui é compatibilidade com provedores que nunca vamos poder testar (nenhum bucket real no desenvolvimento): o SDK é o cliente que todos eles testam
 * contra, trata região/redirecionamento/path-style e o corpo em fluxo. O custo (~60 pacotes) é aceito; `forcePathStyle` + `requestChecksumCalculation: WHEN_REQUIRED` mantêm o fio
 * compatível com os S3 "genéricos" (o CRC32 por padrão dos SDKs novos derruba alguns).
 *
 * SEGURANÇA: o `lookup` do agente HTTP(S) revalida CADA endereço resolvido na conexão (fecha o DNS rebinding: o nome que passou na checagem pode resolver diferente ao conectar).
 * Segredos entram só aqui, vindos já decifrados do chamador, e nunca saem em log/mensagem. O detalhe cru do SDK vai só para o log (passando por `limparTextoSensivel`): a tela e o
 * histórico recebem um CÓDIGO.
 */

export interface ConfigDoS3 {
  endpoint: string
  region: string | null
  bucket: string
  prefix: string | null
  accessKeyId: string
  secretAccessKey: string
}

export function politicaDeDestinoDoBackup(fonteEnv: Readonly<Record<string, string | undefined>> = process.env): PoliticaDeDestino {
  const t = (fonteEnv.BACKUP_ALLOW_PRIVATE_HOSTS ?? '').trim().toLowerCase()
  return { producao: fonteEnv.NODE_ENV === 'production', permitirRedePrivada: ['true', '1', 'yes', 'on'].includes(t) }
}

type LookupOpcoes = { all?: boolean; family?: number; hints?: number }
type LookupResposta = Array<{ address: string; family: number }>
type ResolvedorDns = (host: string, opcoes: LookupOpcoes, cb: (err: NodeJS.ErrnoException | null, enderecos: LookupResposta) => void) => void

/** `lookup` para o agente HTTP(S): resolve e RECUSA a conexão se qualquer endereço devolvido for proibido pela política. `resolvedor` existe para os testes. */
export function criarLookupGuardado(politica: PoliticaDeDestino, resolvedor?: ResolvedorDns) {
  const real: ResolvedorDns =
    resolvedor ??
    ((host, opcoes, cb) => {
      dns.lookup(host, { all: true, verbatim: true, family: opcoes.family }, (err, enderecos) => cb(err, enderecos as LookupResposta))
    })
  return (host: string, opcoes: LookupOpcoes | undefined, callback: (err: NodeJS.ErrnoException | null, address?: string | LookupResposta, family?: number) => void): void => {
    const o = opcoes ?? {}
    real(host, o, (err, enderecos) => {
      if (err) return callback(err)
      if (!enderecos || enderecos.length === 0) return callback(Object.assign(new Error('DNS sem resultado.'), { code: 'ENOTFOUND' }) as NodeJS.ErrnoException)
      if (enderecos.some((e) => validarHostDeclarado(e.address, politica) !== null)) {
        return callback(Object.assign(new Error('O endereço do bucket resolve para um destino proibido.'), { code: 'EBLOCKEDADDR' }) as NodeJS.ErrnoException)
      }
      if (o.all) return callback(null, enderecos)
      callback(null, enderecos[0].address, enderecos[0].family)
    })
  }
}

export function criarClienteS3(cfg: ConfigDoS3, politica: PoliticaDeDestino = politicaDeDestinoDoBackup()): S3Client {
  const verificado = validarEnderecoS3(cfg.endpoint, politica)
  if (!verificado.ok) throw new ErroDeBackup(`Endereço do bucket recusado: ${verificado.mensagem}`, 'CONFIG')
  const lookup = criarLookupGuardado(politica) as never
  return new S3Client({
    region: cfg.region?.trim() || 'us-east-1',
    endpoint: cfg.endpoint,
    credentials: { accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey },
    forcePathStyle: true,
    // UMA tentativa por chamada: o corpo em fluxo (arquivo) não pode ser relido pelo retry do SDK; a retentativa com fluxo NOVO é do serviço (`comRetentativa`).
    maxAttempts: 1,
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
    requestHandler: {
      connectionTimeout: 15_000,
      // Inatividade do socket (zera a cada bloco enviado/recebido): um upload de gigas pode demorar, parado é que não pode.
      requestTimeout: 120_000,
      httpAgent: new http.Agent({ keepAlive: false, lookup }),
      httpsAgent: new https.Agent({ keepAlive: false, lookup }),
    },
  })
}

/** Traduz o erro do SDK/rede num CÓDIGO acionável. O detalhe cru vai só para o log. */
export function classificarFalhaS3(err: unknown, fazendo: string): ErroDeBackup {
  if (err instanceof ErroDeBackup) return err
  const e = err as { name?: string; code?: string; message?: string; $metadata?: { httpStatusCode?: number } }
  const nome = e?.name ?? ''
  const status = e?.$metadata?.httpStatusCode
  logger.warn({ fazendo, errName: nome || 'desconhecido', errCode: e?.code, httpStatus: status, detalhe: limparTextoSensivel(String(e?.message ?? '')).slice(0, 300) }, '[backup][s3] operação falhou')
  if (e?.code === 'EBLOCKEDADDR') return new ErroDeBackup('O endereço do bucket resolve para um destino proibido.', 'CONFIG')
  if (['InvalidAccessKeyId', 'SignatureDoesNotMatch', 'AccessDenied', 'InvalidToken', 'ExpiredToken', 'AuthorizationHeaderMalformed', 'InvalidSecurity'].includes(nome) || status === 401 || status === 403) {
    return new ErroDeBackup('O bucket recusou a credencial.', 'CREDENTIAL')
  }
  if (nome === 'NoSuchBucket' || status === 404) return new ErroDeBackup('O bucket não existe nesse endereço.', 'FOLDER')
  if (['EntityTooLarge'].includes(nome)) return new ErroDeBackup('Arquivo grande demais para o envio simples.', 'TOO_BIG')
  if (['QuotaExceeded', 'StorageLimitExceeded'].includes(nome)) return new ErroDeBackup('Sem espaço no destino.', 'QUOTA')
  if (status === 507) return new ErroDeBackup('Sem espaço no destino.', 'QUOTA')
  return new ErroDeBackup('Falha de rede ao falar com o bucket.', 'NETWORK')
}

export interface ObjetoRemoto extends CopiaNoDestino {
  nome: string
  tamanho: number | null
}

/** Sobe o arquivo (já cifrado) em fluxo. `sha256` vai como metadado do objeto (`x-amz-meta-sha256`): a conferência semanal reconfere mesmo sem o banco. */
export async function enviarObjeto(s3: S3Client, cfg: ConfigDoS3, item: { arquivo: string; nome: string; tamanho: number; sha256: string }): Promise<string> {
  if (item.tamanho > LIMITE_DO_ENVIO_SIMPLES_BYTES) throw new ErroDeBackup('Arquivo maior que 5 GiB.', 'TOO_BIG')
  const chave = chaveDoObjeto(cfg.prefix, item.nome)
  try {
    await s3.send(
      new PutObjectCommand({
        Bucket: cfg.bucket,
        Key: chave,
        Body: createReadStream(item.arquivo),
        ContentLength: item.tamanho,
        ContentType: 'application/octet-stream',
        Metadata: { sha256: item.sha256 },
      }),
    )
  } catch (err) {
    throw classificarFalhaS3(err, 'enviar')
  }
  return chave
}

/** Lista só o que é NOSSO backup (`backup-*.dump[.enc]`), paginando até o fim. Qualquer outro objeto no prefixo é ignorado. */
export async function listarCopias(s3: S3Client, cfg: ConfigDoS3): Promise<ObjetoRemoto[]> {
  const prefixo = prefixoNormalizado(cfg.prefix)
  const itens: ObjetoRemoto[] = []
  let token: string | undefined
  try {
    do {
      const pagina = await s3.send(new ListObjectsV2Command({ Bucket: cfg.bucket, Prefix: prefixo ? `${prefixo}/` : undefined, ContinuationToken: token }))
      for (const o of pagina.Contents ?? []) {
        const nome = o.Key?.split('/').pop() ?? ''
        if (!o.Key || !o.LastModified || !ehNomeDeBackup(nome)) continue
        // Só o próprio prefixo, não subpastas (`prefixo/outro/backup-x.dump.enc` é de outra instalação).
        if (prefixo && o.Key !== `${prefixo}/${nome}`) continue
        if (!prefixo && o.Key !== nome) continue
        itens.push({ id: o.Key, nome, criadaEm: o.LastModified, tamanho: o.Size ?? null })
      }
      token = pagina.IsTruncated ? pagina.NextContinuationToken : undefined
    } while (token)
  } catch (err) {
    throw classificarFalhaS3(err, 'listar')
  }
  return itens
}

/** Baixa o objeto em fluxo para `destino` (0600). Quem chama apaga o temporário. Devolve o `sha256` do metadado, se houver. */
export async function baixarObjeto(s3: S3Client, cfg: ConfigDoS3, chave: string, destino: string): Promise<{ sha256DoMetadado: string | null }> {
  try {
    const res = await s3.send(new GetObjectCommand({ Bucket: cfg.bucket, Key: chave }))
    if (!res.Body) throw new ErroDeBackup('Resposta sem corpo.', 'NETWORK')
    await pipeline(res.Body as Readable, createWriteStream(destino, { mode: 0o600 }))
    const meta = res.Metadata?.sha256
    return { sha256DoMetadado: typeof meta === 'string' && /^[0-9a-f]{64}$/.test(meta) ? meta : null }
  } catch (err) {
    throw classificarFalhaS3(err, 'baixar')
  }
}

export async function apagarObjetos(s3: S3Client, cfg: ConfigDoS3, chaves: string[]): Promise<number> {
  let apagados = 0
  for (let i = 0; i < chaves.length; i += 1000) {
    const lote = chaves.slice(i, i + 1000)
    try {
      const res = await s3.send(new DeleteObjectsCommand({ Bucket: cfg.bucket, Delete: { Objects: lote.map((Key) => ({ Key })), Quiet: true } }))
      apagados += lote.length - (res.Errors?.length ?? 0)
    } catch (err) {
      throw classificarFalhaS3(err, 'apagar')
    }
  }
  return apagados
}

/** Prova o destino sem mexer nos backups: grava e apaga um arquivinho de teste (prova gravar E apagar, que é o que a retenção precisa). */
export async function testarEscritaEApagar(s3: S3Client, cfg: ConfigDoS3): Promise<void> {
  const chave = chaveDoObjeto(cfg.prefix, `.teste-conexao-${randomUUID().slice(0, 8)}.tmp`)
  try {
    await s3.send(new PutObjectCommand({ Bucket: cfg.bucket, Key: chave, Body: 'teste de conexao do InnoFlow', ContentType: 'text/plain' }))
    await s3.send(new DeleteObjectCommand({ Bucket: cfg.bucket, Key: chave }))
  } catch (err) {
    throw classificarFalhaS3(err, 'testar')
  }
}
