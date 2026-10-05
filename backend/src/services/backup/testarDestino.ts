import { ErroDeBackup, mensagemDoErro, type CodigoDeErroDoBackup } from '../../core/backup/erros'
import { destinoAtivo, type DestinoDeBackup } from '../../core/backup/politica'
import { carregarConfigDeBackup } from './configBackup'
import { criarDestinoDaConfig, type DestinoRemoto } from './destinos'
import { paraCodigo } from './executarBackup'

export interface ResultadoDoTesteDeDestino {
  ok: boolean
  destination: DestinoDeBackup | null
  message: string
  error?: { code: CodigoDeErroDoBackup; message: string }
}

/**
 * Prova o destino SEM mexer nos backups: no S3 grava e apaga um arquivinho de teste (prova gravar E apagar, que é o que a retenção precisa); no Drive pede acesso e abre a pasta.
 * Sempre devolve o RESULTADO (a rota responde 200 com `ok: false` + `error.code`): falha do destino é o resultado do teste, não erro da rota. Roda na API (não precisa de `pg_dump`).
 * O `message` e o `error.message` são textos FIXOS por código — nunca a resposta crua do destino (num endereço malicioso ela viraria canal de leitura de uma rede interna).
 */
export async function testarDestinoDeBackup(deps: { destino?: DestinoRemoto | null } = {}): Promise<ResultadoDoTesteDeDestino> {
  const config = await carregarConfigDeBackup()
  const nome = destinoAtivo(config)
  try {
    const remoto = deps.destino !== undefined ? deps.destino : criarDestinoDaConfig(config)
    if (!remoto) throw new ErroDeBackup('Destino incompleto.', 'CONFIG')
    await remoto.testar()
    return {
      ok: true,
      destination: remoto.tipo,
      message: remoto.tipo === 'S3' ? `O bucket "${config.s3Bucket ?? ''}" aceitou gravar e apagar um arquivo de teste.` : 'O Google aceitou o acesso e a pasta está pronta para receber os backups.',
    }
  } catch (err) {
    const code = paraCodigo(err)
    return { ok: false, destination: nome, message: 'O teste do destino falhou.', error: { code, message: mensagemDoErro(code) ?? '' } }
  }
}
