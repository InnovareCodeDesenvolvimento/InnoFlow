/**
 * Bloqueio de SSRF para os destinos que o ADMIN configura pelo painel (host do SMTP e URL da Evolution API). Puro (a resolução de DNS entra por injeção).
 *
 * Ameaça: um painel admin comprometido (ou um admin malicioso) aponta o "servidor de e-mail"/"Evolution" para um endereço INTERNO e usa o botão de teste
 * ou o aviso de alerta como scanner/proxy da rede do servidor (banco, Redis, metadados da nuvem em 169.254.169.254).
 *
 * Política:
 *  - SEMPRE bloqueado (mesmo com a permissão de rede privada): endereço não roteável/ "este host" (0.0.0.0/8), link-local (169.254.0.0/16 — metadados de
 *    nuvem — e fe80::/10), multicast/reservado, e os nomes de metadados conhecidos.
 *  - Bloqueado em PRODUÇÃO: loopback (127/8, ::1, `localhost`), redes privadas (10/8, 172.16/12, 192.168/16, 100.64/10 CGNAT, fc00::/7) e nomes de rede interna
 *    (`*.local`, `*.internal`, `*.localhost`, hostname sem ponto). Fora de produção (dev/CI) tudo isso é liberado, para testar contra servidores locais.
 *  - Exceção EXPLÍCITA de infraestrutura: `permitirRedePrivada` (env `COMMUNICATION_ALLOW_PRIVATE_HOSTS=true`, que só quem controla o deploy define — NÃO existe campo
 *    no painel para isso) libera as redes PRIVADAS e nomes internos (ex.: Evolution API no mesmo projeto do EasyPanel, `http://evolution:8080`), mas NUNCA
 *    link-local/metadados nem loopback.
 *
 * A defesa contra DNS rebinding é a QUEM CONECTA: resolve o nome UMA vez, valida TODOS os endereços devolvidos e conecta no IP validado (nunca resolve de novo).
 */
import { isIP } from 'node:net'

export type MotivoDestinoBloqueado =
  | 'HOST_INVALIDO'
  | 'ENDERECO_NAO_ROTEAVEL'
  | 'ENDERECO_DE_METADADOS'
  | 'LOOPBACK'
  | 'REDE_PRIVADA'
  | 'NOME_INTERNO'
  | 'DNS_SEM_RESULTADO'

export class DestinoBloqueadoError extends Error {
  constructor(readonly motivo: MotivoDestinoBloqueado) {
    super(`destino bloqueado: ${motivo}`)
    this.name = 'DestinoBloqueadoError'
  }
}

export interface PoliticaDeDestino {
  producao: boolean
  permitirRedePrivada: boolean
}

type Classe = 'PUBLICO' | MotivoDestinoBloqueado

function ipv4EmPartes(ip: string): number[] | null {
  const p = ip.split('.')
  if (p.length !== 4) return null
  const n = p.map((x) => (/^\d{1,3}$/.test(x) ? Number(x) : NaN))
  return n.some((x) => Number.isNaN(x) || x > 255) ? null : n
}

/** Classifica um IP LITERAL (v4 ou v6). Inválido => HOST_INVALIDO. */
export function classificarIp(ip: string): Classe {
  const familia = isIP(ip)
  if (familia === 4) return classificarIpv4(ipv4EmPartes(ip)!)
  if (familia === 6) return classificarIpv6(ip.toLowerCase())
  return 'HOST_INVALIDO'
}

function classificarIpv4([a, b]: number[]): Classe {
  if (a === 0) return 'ENDERECO_NAO_ROTEAVEL'
  if (a === 169 && b === 254) return 'ENDERECO_DE_METADADOS'
  if (a === 127) return 'LOOPBACK'
  if (a === 10) return 'REDE_PRIVADA'
  if (a === 172 && b >= 16 && b <= 31) return 'REDE_PRIVADA'
  if (a === 192 && b === 168) return 'REDE_PRIVADA'
  if (a === 100 && b >= 64 && b <= 127) return 'REDE_PRIVADA' // CGNAT
  if (a >= 224) return 'ENDERECO_NAO_ROTEAVEL' // multicast e reservado (224/4, 240/4, broadcast)
  if (a === 192 && b === 0) return 'ENDERECO_NAO_ROTEAVEL' // 192.0.0.0/24 e 192.0.2.0/24 (documentação)
  if (a === 198 && (b === 18 || b === 19)) return 'ENDERECO_NAO_ROTEAVEL' // benchmarking
  return 'PUBLICO'
}

/** Expande um IPv6 textual em 8 grupos de 16 bits (aceita `::` e o sufixo IPv4). */
function ipv6EmGrupos(ip: string): number[] | null {
  let texto = ip
  const v4 = /(\d{1,3}(?:\.\d{1,3}){3})$/.exec(texto)
  if (v4) {
    const p = ipv4EmPartes(v4[1])
    if (!p) return null
    texto = texto.slice(0, -v4[1].length) + ((p[0] << 8) | p[1]).toString(16) + ':' + ((p[2] << 8) | p[3]).toString(16)
  }
  const [cabeca, cauda, ...resto] = texto.split('::')
  if (resto.length > 0) return null
  const a = cabeca === '' ? [] : cabeca.split(':')
  const b = cauda === undefined || cauda === '' ? [] : cauda.split(':')
  const faltam = 8 - a.length - b.length
  if (cauda === undefined ? a.length !== 8 : faltam < 0) return null
  const todos = cauda === undefined ? a : [...a, ...Array<string>(faltam).fill('0'), ...b]
  const g = todos.map((x) => (/^[0-9a-f]{1,4}$/.test(x) ? parseInt(x, 16) : NaN))
  return g.length === 8 && !g.some(Number.isNaN) ? g : null
}

function classificarIpv6(ip: string): Classe {
  const g = ipv6EmGrupos(ip)
  if (!g) return 'HOST_INVALIDO'
  if (g.every((x) => x === 0)) return 'ENDERECO_NAO_ROTEAVEL' // ::
  if (g.slice(0, 7).every((x) => x === 0) && g[7] === 1) return 'LOOPBACK' // ::1
  // IPv4 embutido: ::ffff:a.b.c.d (mapeado), ::a.b.c.d (compatível) e 64:ff9b::/96 (NAT64) — vale a classe do IPv4.
  const mapeado = g.slice(0, 5).every((x) => x === 0) && (g[5] === 0xffff || g[5] === 0)
  const nat64 = g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every((x) => x === 0)
  if (mapeado || nat64) return classificarIpv4([g[6] >> 8, g[6] & 255, g[7] >> 8, g[7] & 255])
  if ((g[0] & 0xffc0) === 0xfe80) return 'ENDERECO_DE_METADADOS' // fe80::/10 link-local
  if (g[0] === 0xfd00 && g[1] === 0x0ec2) return 'ENDERECO_DE_METADADOS' // metadados da AWS (IMDS IPv6)
  if ((g[0] & 0xfe00) === 0xfc00) return 'REDE_PRIVADA' // fc00::/7
  if ((g[0] & 0xff00) === 0xff00) return 'ENDERECO_NAO_ROTEAVEL' // multicast
  if (g[0] === 0x2001 && g[1] === 0x0db8) return 'ENDERECO_NAO_ROTEAVEL' // documentação
  return 'PUBLICO'
}

const NOMES_DE_METADADOS = new Set(['metadata.google.internal', 'metadata', 'instance-data', 'instance-data.ec2.internal'])

/** Classifica um NOME (não IP). */
export function classificarNome(host: string): Classe {
  const h = host.toLowerCase().replace(/\.$/, '')
  if (h === '' || /[^a-z0-9.-]/.test(h) || h.startsWith('-') || h.includes('..')) return 'HOST_INVALIDO'
  if (NOMES_DE_METADADOS.has(h)) return 'ENDERECO_DE_METADADOS'
  if (h === 'localhost' || h.endsWith('.localhost')) return 'LOOPBACK'
  if (h.endsWith('.local') || h.endsWith('.internal') || h.endsWith('.lan') || h.endsWith('.home.arpa') || !h.includes('.')) return 'NOME_INTERNO'
  return 'PUBLICO'
}

/** Tira os colchetes de um IPv6 de URL (`[::1]`). */
export function hostSemColchetes(host: string): string {
  return host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host
}

function aplicarPolitica(classe: Classe, p: PoliticaDeDestino): MotivoDestinoBloqueado | null {
  switch (classe) {
    case 'PUBLICO':
      return null
    case 'HOST_INVALIDO':
    case 'ENDERECO_NAO_ROTEAVEL':
    case 'ENDERECO_DE_METADADOS':
    case 'DNS_SEM_RESULTADO':
      return classe
    case 'LOOPBACK':
      return p.producao ? 'LOOPBACK' : null
    case 'REDE_PRIVADA':
    case 'NOME_INTERNO':
      return p.producao && !p.permitirRedePrivada ? classe : null
  }
}

/** Host de rede interna/privada (privada, `*.internal`, hostname sem ponto) — NÃO inclui loopback nem metadados. */
export function hostEhRedePrivada(hostBruto: string): boolean {
  const host = hostSemColchetes(hostBruto.trim())
  const classe = isIP(host) ? classificarIp(host) : classificarNome(host)
  return classe === 'REDE_PRIVADA' || classe === 'NOME_INTERNO'
}

/** Valida SÓ o host escrito (sem DNS): para recusar já na gravação da configuração. Nome público passa aqui e é revalidado ao resolver, na hora de conectar. */
export function validarHostDeclarado(hostBruto: string, politica: PoliticaDeDestino): MotivoDestinoBloqueado | null {
  const host = hostSemColchetes(hostBruto.trim())
  const classe = isIP(host) ? classificarIp(host) : classificarNome(host)
  return aplicarPolitica(classe, politica)
}

export type ResolvedorDns = (host: string) => Promise<Array<{ address: string; family: number }>>

export interface DestinoResolvido {
  /** IP validado onde conectar. */
  ip: string
  familia: 4 | 6
}

/**
 * Resolve o host UMA vez e valida TODOS os endereços (basta um interno para recusar: o resolvedor do SO poderia escolher qualquer um). Devolve o primeiro
 * validado para a conexão. Lança `DestinoBloqueadoError`.
 */
export async function resolverDestinoSeguro(hostBruto: string, politica: PoliticaDeDestino, resolver: ResolvedorDns): Promise<DestinoResolvido> {
  const host = hostSemColchetes(hostBruto.trim())
  const declarado = validarHostDeclarado(host, politica)
  if (declarado) throw new DestinoBloqueadoError(declarado)
  if (isIP(host)) return { ip: host, familia: isIP(host) === 6 ? 6 : 4 }
  let enderecos: Array<{ address: string; family: number }>
  try {
    enderecos = await resolver(host)
  } catch {
    throw new DestinoBloqueadoError('DNS_SEM_RESULTADO')
  }
  if (enderecos.length === 0) throw new DestinoBloqueadoError('DNS_SEM_RESULTADO')
  for (const e of enderecos) {
    const motivo = aplicarPolitica(classificarIp(e.address), politica)
    if (motivo) throw new DestinoBloqueadoError(motivo)
  }
  return { ip: enderecos[0].address, familia: isIP(enderecos[0].address) === 6 ? 6 : 4 }
}

/** Mensagem PT-BR para o admin (sem revelar o endereço interno achado). */
export function mensagemDeDestinoBloqueado(motivo: MotivoDestinoBloqueado): string {
  switch (motivo) {
    case 'HOST_INVALIDO':
      return 'Endereço inválido.'
    case 'DNS_SEM_RESULTADO':
      return 'Não foi possível resolver o endereço (DNS).'
    case 'ENDERECO_DE_METADADOS':
      return 'Este endereço é reservado (rede local/metadados) e não pode ser usado.'
    case 'ENDERECO_NAO_ROTEAVEL':
      return 'Este endereço não é um destino público válido.'
    case 'LOOPBACK':
    case 'REDE_PRIVADA':
    case 'NOME_INTERNO':
      return 'Este endereço aponta para a rede interna do servidor e não é permitido em produção. Use o endereço PÚBLICO (https) do serviço.'
  }
}
