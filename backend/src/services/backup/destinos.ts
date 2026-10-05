import type { S3Client } from '@aws-sdk/client-s3'
import { ErroDeBackup } from '../../core/backup/erros'
import { destinoAtivo, type CopiaNoDestino, type DestinoDeBackup } from '../../core/backup/politica'
import { apagarObjetos, baixarObjeto, criarClienteS3, enviarObjeto, listarCopias, testarEscritaEApagar, type ConfigDoS3 } from '../../lib/backup/s3'
import { apagarDoDrive, baixarDoDrive, conferirPastaDoDrive, enviarParaODrive, listarDumpsDoDrive, type TokenGetter } from '../../lib/backup/drive'
import { tokenGetterDoOAuth } from '../../lib/backup/driveOAuth'
import { lerSegredoDaConfig, type LinhaDeBackup } from './configBackup'

/**
 * O destino do backup (S3 ou Google Drive) atrás de UMA interface — o executor, a conferência, a retenção e o "Testar destino" não sabem qual é. Os segredos são decifrados aqui, na
 * hora de montar o destino (e só aqui): `ErroDeBackup('SECRETS_KEY')` se o JWT_SECRET (de onde deriva a chave dos segredos) mudar, ANTES de gastar um dump inteiro.
 */

export interface CopiaRemota extends CopiaNoDestino {
  nome: string
  tamanho: number | null
}

export interface DestinoRemoto {
  tipo: DestinoDeBackup
  /** Sobe o arquivo já cifrado. Devolve a REFERÊNCIA gravada em `BackupRun.objectKey` (chave do objeto no S3; `drive:<id>/<nome>` no Drive). */
  enviar(item: { arquivo: string; nome: string; tamanho: number; sha256: string }): Promise<string>
  /** Só o que é NOSSO backup (`backup-*.dump[.enc]`). */
  listar(): Promise<CopiaRemota[]>
  /** Baixa para `destino` (0600). Devolve o SHA-256 guardado como metadado no envio, quando o destino guarda (S3). */
  baixar(copia: CopiaRemota, destino: string): Promise<{ sha256DoMetadado: string | null }>
  apagar(ids: string[]): Promise<number>
  /** Prova o destino sem mexer nos backups. */
  testar(): Promise<void>
  /** A referência gravada em `objectKey` para uma cópia listada. */
  referencia(copia: CopiaRemota): string
}

function configDoS3(config: LinhaDeBackup): ConfigDoS3 {
  const accessKeyId = lerSegredoDaConfig(config.s3AccessKeyCiphertext, 's3AccessKey')
  const secretAccessKey = lerSegredoDaConfig(config.s3SecretKeyCiphertext, 's3SecretKey')
  if (!config.s3Endpoint || !config.s3Bucket || !accessKeyId || !secretAccessKey) throw new ErroDeBackup('Destino S3 incompleto.', 'CONFIG')
  return { endpoint: config.s3Endpoint, region: config.s3Region, bucket: config.s3Bucket, prefix: config.s3Prefix, accessKeyId, secretAccessKey }
}

export function criarDestinoS3(config: LinhaDeBackup, clienteInjetado?: S3Client): DestinoRemoto {
  const cfg = configDoS3(config)
  const s3 = clienteInjetado ?? criarClienteS3(cfg)
  return {
    tipo: 'S3',
    enviar: (item) => enviarObjeto(s3, cfg, item),
    listar: async () => (await listarCopias(s3, cfg)).map((o) => ({ id: o.id, criadaEm: o.criadaEm, nome: o.nome, tamanho: o.tamanho })),
    baixar: (copia, destino) => baixarObjeto(s3, cfg, copia.id, destino),
    apagar: (ids) => apagarObjetos(s3, cfg, ids),
    testar: () => testarEscritaEApagar(s3, cfg),
    referencia: (copia) => copia.id,
  }
}

function acessoDoDrive(config: LinhaDeBackup): { token: TokenGetter; pastaId: string } {
  if (!config.driveOauthRefreshTokenCiphertext || !config.driveOauthFolderId || !config.driveOauthClientId) throw new ErroDeBackup('Não há conta Google conectada.', 'OAUTH_DISCONNECTED')
  const clientSecret = lerSegredoDaConfig(config.driveOauthClientSecretCiphertext, 'driveClientSecret')
  const refreshToken = lerSegredoDaConfig(config.driveOauthRefreshTokenCiphertext, 'driveRefreshToken')
  if (!clientSecret || !refreshToken) throw new ErroDeBackup('Não há conta Google conectada.', 'OAUTH_DISCONNECTED')
  return { token: tokenGetterDoOAuth({ clientId: config.driveOauthClientId, clientSecret, refreshToken }), pastaId: config.driveOauthFolderId }
}

export function criarDestinoDrive(config: LinhaDeBackup): DestinoRemoto {
  const { token, pastaId } = acessoDoDrive(config)
  return {
    tipo: 'DRIVE',
    enviar: async (item) => {
      const { arquivoId } = await enviarParaODrive({ token, pastaId, arquivo: item.arquivo, nome: item.nome, tamanho: item.tamanho })
      return `drive:${arquivoId}/${item.nome}`
    },
    listar: async () => (await listarDumpsDoDrive(token, pastaId)).map((f) => ({ id: f.id, criadaEm: f.criadoEm, nome: f.nome, tamanho: f.tamanho })),
    baixar: async (copia, destino) => {
      await baixarDoDrive(token, copia.id, destino)
      return { sha256DoMetadado: null } // o Drive não guarda o nosso SHA-256: a conferência usa o gravado em BackupRun
    },
    apagar: (ids) => apagarDoDrive(token, ids),
    testar: () => conferirPastaDoDrive(token, pastaId),
    referencia: (copia) => `drive:${copia.id}/${copia.nome}`,
  }
}

/** O destino ATIVO da config, ou `null` se o dump não sai do servidor (nada configurado/completo). */
export function criarDestinoDaConfig(config: LinhaDeBackup): DestinoRemoto | null {
  switch (destinoAtivo(config)) {
    case 'S3':
      return criarDestinoS3(config)
    case 'DRIVE':
      return criarDestinoDrive(config)
    default:
      return null
  }
}

/** Retentativa só para falha de REDE (não para credencial/pasta/cota, que não se resolvem repetindo). `dormir` injetável. */
export async function comRetentativa<T>(operacao: () => Promise<T>, opcoes: { esperasMs?: number[]; dormir?: (ms: number) => Promise<void> } = {}): Promise<T> {
  const esperas = opcoes.esperasMs ?? [2_000, 10_000]
  const dormir = opcoes.dormir ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  for (let tentativa = 0; ; tentativa += 1) {
    try {
      return await operacao()
    } catch (err) {
      const repetivel = err instanceof ErroDeBackup && err.codigo === 'NETWORK'
      if (!repetivel || tentativa >= esperas.length) throw err
      await dormir(esperas[tentativa] as number)
    }
  }
}
