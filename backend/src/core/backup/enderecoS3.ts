/**
 * Endereço do bucket S3-compatível que o ADMIN digita. O dump INTEIRO (todos os dados do banco, ainda que cifrado) sai por ele e o botão "Testar destino" devolve o resultado à
 * tela — logo o endereço é vetor de SSRF e de envio em texto puro. Mesma política dos destinos de comunicação (`core/comunicacao/destinoSeguro.ts`), com as regras de URL próprias:
 *  - `https` obrigatório em produção; `http` só fora dela, ou em produção SE a permissão de rede privada do deploy (`BACKUP_ALLOW_PRIVATE_HOSTS=true`, NÃO há campo no painel) está
 *    ligada E o host é de rede interna (MinIO no mesmo projeto do EasyPanel, `http://minio:9000`);
 *  - sem usuário/senha, sem query e sem fragmento na URL (credencial tem campo próprio);
 *  - host passa pela política anti-SSRF (metadados de nuvem/link-local/não roteável SEMPRE bloqueados; loopback e rede privada só fora de produção ou com a permissão);
 *  - o NOME é revalidado ao RESOLVER, na hora de conectar (`criarLookupGuardado`), contra DNS rebinding.
 * Puro: o DNS entra por injeção.
 */
import { hostEhRedePrivada, hostSemColchetes, mensagemDeDestinoBloqueado, validarHostDeclarado, type MotivoDestinoBloqueado, type PoliticaDeDestino } from '../comunicacao/destinoSeguro'

export type ResultadoDoEnderecoS3 = { ok: true; url: URL } | { ok: false; codigo: 'INVALID_URL' | 'HTTPS_REQUIRED' | 'URL_HAS_CREDENTIALS' | 'URL_HAS_EXTRAS' | 'DESTINATION_NOT_ALLOWED'; motivo?: MotivoDestinoBloqueado; mensagem: string }

export function validarEnderecoS3(bruto: string, politica: PoliticaDeDestino): ResultadoDoEnderecoS3 {
  let url: URL
  try {
    url = new URL(bruto.trim())
  } catch {
    return { ok: false, codigo: 'INVALID_URL', mensagem: 'O endereço do bucket não é uma URL válida (ex.: https://s3.us-east-1.amazonaws.com).' }
  }
  const host = hostSemColchetes(url.hostname)
  const httpInternoPermitido = politica.permitirRedePrivada && hostEhRedePrivada(host)
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && (!politica.producao || httpInternoPermitido))) {
    return { ok: false, codigo: 'HTTPS_REQUIRED', mensagem: `O endereço do bucket precisa começar com https://${politica.producao ? ' em produção' : ''}.` }
  }
  if (url.username || url.password) {
    return { ok: false, codigo: 'URL_HAS_CREDENTIALS', mensagem: 'Não coloque usuário e senha no endereço. Eles vão nos campos de chave de acesso e segredo.' }
  }
  if (url.search || url.hash) {
    return { ok: false, codigo: 'URL_HAS_EXTRAS', mensagem: 'O endereço do bucket não pode ter "?" nem "#".' }
  }
  const motivo = validarHostDeclarado(host, politica)
  if (motivo) return { ok: false, codigo: 'DESTINATION_NOT_ALLOWED', motivo, mensagem: mensagemDeDestinoBloqueado(motivo) }
  return { ok: true, url }
}

/** O endereço guardado, sem barra no fim (o SDK monta `endpoint/bucket/chave`). */
export function enderecoNormalizado(url: URL): string {
  return url.toString().replace(/\/+$/, '')
}

/** Prefixo dentro do bucket: sem barras nas pontas e sem `..` (nada de "sair" do prefixo). Vazio = raiz. */
export function prefixoNormalizado(bruto: string | null | undefined): string {
  return (bruto ?? '')
    .replace(/\\/g, '/')
    .split('/')
    .filter((p) => p !== '' && p !== '.' && p !== '..')
    .join('/')
}

/** Chave do objeto no bucket: `prefixo/nome` (ou só `nome`). */
export function chaveDoObjeto(prefixo: string | null | undefined, nome: string): string {
  const p = prefixoNormalizado(prefixo)
  return p ? `${p}/${nome}` : nome
}
