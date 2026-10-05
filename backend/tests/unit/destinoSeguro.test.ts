/** N-7 — trava de SSRF dos destinos configurados pelo painel (host SMTP, URL da Evolution) e a conexão que usa o IP VALIDADO (anti DNS rebinding). */
import { describe, expect, it } from 'vitest'
import {
  DestinoBloqueadoError,
  classificarIp,
  classificarNome,
  hostEhRedePrivada,
  resolverDestinoSeguro,
  validarHostDeclarado,
  type PoliticaDeDestino,
  type ResolvedorDns,
} from '../../src/core/comunicacao/destinoSeguro'
import { FalhaDeCanal, criarCanalEvolution, criarCanalEmail, type RequisitorHttp } from '../../src/lib/alertas/canais'
import type { ConfigEmail, ConfigWhatsappEvolution } from '../../src/lib/alertas/config'
import type { EventoDeAlerta } from '../../src/core/alertas/formatar'

const PROD: PoliticaDeDestino = { producao: true, permitirRedePrivada: false }
const PROD_PRIVADO: PoliticaDeDestino = { producao: true, permitirRedePrivada: true }
const DEV: PoliticaDeDestino = { producao: false, permitirRedePrivada: false }

describe('classificarIp', () => {
  it('IPv4', () => {
    expect(classificarIp('8.8.8.8')).toBe('PUBLICO')
    expect(classificarIp('127.0.0.1')).toBe('LOOPBACK')
    expect(classificarIp('127.255.255.254')).toBe('LOOPBACK')
    expect(classificarIp('10.1.2.3')).toBe('REDE_PRIVADA')
    expect(classificarIp('172.16.0.1')).toBe('REDE_PRIVADA')
    expect(classificarIp('172.31.255.255')).toBe('REDE_PRIVADA')
    expect(classificarIp('172.32.0.1')).toBe('PUBLICO')
    expect(classificarIp('192.168.1.1')).toBe('REDE_PRIVADA')
    expect(classificarIp('100.64.0.1')).toBe('REDE_PRIVADA')
    expect(classificarIp('169.254.169.254')).toBe('ENDERECO_DE_METADADOS')
    expect(classificarIp('0.0.0.0')).toBe('ENDERECO_NAO_ROTEAVEL')
    expect(classificarIp('224.0.0.1')).toBe('ENDERECO_NAO_ROTEAVEL')
    expect(classificarIp('255.255.255.255')).toBe('ENDERECO_NAO_ROTEAVEL')
  })

  it('IPv6, inclusive IPv4 embutido (mapeado) e formas curtas/longas', () => {
    expect(classificarIp('2606:4700:4700::1111')).toBe('PUBLICO')
    expect(classificarIp('::1')).toBe('LOOPBACK')
    expect(classificarIp('0:0:0:0:0:0:0:1')).toBe('LOOPBACK')
    expect(classificarIp('::')).toBe('ENDERECO_NAO_ROTEAVEL')
    expect(classificarIp('fe80::1')).toBe('ENDERECO_DE_METADADOS')
    expect(classificarIp('fc00::1')).toBe('REDE_PRIVADA')
    expect(classificarIp('fd12:3456::1')).toBe('REDE_PRIVADA')
    expect(classificarIp('fd00:ec2::254')).toBe('ENDERECO_DE_METADADOS')
    expect(classificarIp('::ffff:127.0.0.1')).toBe('LOOPBACK')
    expect(classificarIp('::ffff:169.254.169.254')).toBe('ENDERECO_DE_METADADOS')
    expect(classificarIp('::ffff:10.0.0.1')).toBe('REDE_PRIVADA')
    expect(classificarIp('::ffff:8.8.8.8')).toBe('PUBLICO')
    expect(classificarIp('ff02::1')).toBe('ENDERECO_NAO_ROTEAVEL')
  })

  it('lixo é HOST_INVALIDO', () => {
    for (const x of ['', 'abc', '1.2.3', '1.2.3.4.5', '256.1.1.1', '::g']) expect(classificarIp(x)).toBe('HOST_INVALIDO')
  })
})

describe('classificarNome / validarHostDeclarado', () => {
  it('nomes internos, locais e de metadados', () => {
    expect(classificarNome('localhost')).toBe('LOOPBACK')
    expect(classificarNome('API.Localhost')).toBe('LOOPBACK')
    expect(classificarNome('redis')).toBe('NOME_INTERNO')
    expect(classificarNome('db.internal')).toBe('NOME_INTERNO')
    expect(classificarNome('printer.local')).toBe('NOME_INTERNO')
    expect(classificarNome('metadata.google.internal')).toBe('ENDERECO_DE_METADADOS')
    expect(classificarNome('smtp.exemplo.com.br')).toBe('PUBLICO')
    expect(classificarNome('smtp.exemplo.com.br.')).toBe('PUBLICO')
    expect(classificarNome('a b')).toBe('HOST_INVALIDO')
    expect(classificarNome('a..b')).toBe('HOST_INVALIDO')
  })

  it('política: produção bloqueia loopback/privado/interno; dev libera; metadados e não roteável NUNCA; a permissão do deploy libera só rede privada', () => {
    expect(validarHostDeclarado('127.0.0.1', PROD)).toBe('LOOPBACK')
    expect(validarHostDeclarado('10.0.0.1', PROD)).toBe('REDE_PRIVADA')
    expect(validarHostDeclarado('evolution', PROD)).toBe('NOME_INTERNO')
    expect(validarHostDeclarado('[::1]', PROD)).toBe('LOOPBACK')
    expect(validarHostDeclarado('169.254.169.254', PROD)).toBe('ENDERECO_DE_METADADOS')

    expect(validarHostDeclarado('127.0.0.1', DEV)).toBeNull()
    expect(validarHostDeclarado('10.0.0.1', DEV)).toBeNull()
    expect(validarHostDeclarado('169.254.169.254', DEV)).toBe('ENDERECO_DE_METADADOS')
    expect(validarHostDeclarado('0.0.0.0', DEV)).toBe('ENDERECO_NAO_ROTEAVEL')

    expect(validarHostDeclarado('10.0.0.1', PROD_PRIVADO)).toBeNull()
    expect(validarHostDeclarado('evolution', PROD_PRIVADO)).toBeNull()
    expect(validarHostDeclarado('127.0.0.1', PROD_PRIVADO)).toBe('LOOPBACK') // a permissão NÃO inclui loopback
    expect(validarHostDeclarado('169.254.169.254', PROD_PRIVADO)).toBe('ENDERECO_DE_METADADOS')
    expect(validarHostDeclarado('smtp.exemplo.com.br', PROD)).toBeNull()
  })

  it('hostEhRedePrivada não inclui loopback nem metadados', () => {
    expect(hostEhRedePrivada('10.0.0.1')).toBe(true)
    expect(hostEhRedePrivada('evolution')).toBe(true)
    expect(hostEhRedePrivada('127.0.0.1')).toBe(false)
    expect(hostEhRedePrivada('169.254.169.254')).toBe(false)
    expect(hostEhRedePrivada('smtp.exemplo.com')).toBe(false)
  })
})

describe('resolverDestinoSeguro (DNS validado, TODOS os endereços)', () => {
  const dns = (...enderecos: string[]): ResolvedorDns => async () => enderecos.map((address) => ({ address, family: address.includes(':') ? 6 : 4 }))

  it('nome público que resolve para público: devolve o IP validado', async () => {
    expect(await resolverDestinoSeguro('smtp.exemplo.com', PROD, dns('203.0.113.9'))).toEqual({ ip: '203.0.113.9', familia: 4 })
  })

  it('DNS REBINDING / nome público apontando para endereço interno: bloqueia (basta UM endereço ruim entre vários)', async () => {
    await expect(resolverDestinoSeguro('evil.exemplo.com', PROD, dns('127.0.0.1'))).rejects.toMatchObject({ motivo: 'LOOPBACK' })
    await expect(resolverDestinoSeguro('evil.exemplo.com', PROD, dns('203.0.113.9', '10.0.0.7'))).rejects.toMatchObject({ motivo: 'REDE_PRIVADA' })
    await expect(resolverDestinoSeguro('evil.exemplo.com', PROD, dns('169.254.169.254'))).rejects.toMatchObject({ motivo: 'ENDERECO_DE_METADADOS' })
    await expect(resolverDestinoSeguro('evil.exemplo.com', PROD, dns('::ffff:127.0.0.1'))).rejects.toMatchObject({ motivo: 'LOOPBACK' })
  })

  it('IP literal não consulta DNS; literal proibido é bloqueado; DNS sem resultado/erro vira DNS_SEM_RESULTADO', async () => {
    const naoDeveChamar: ResolvedorDns = async () => {
      throw new Error('não devia consultar DNS')
    }
    expect(await resolverDestinoSeguro('203.0.113.9', PROD, naoDeveChamar)).toEqual({ ip: '203.0.113.9', familia: 4 })
    await expect(resolverDestinoSeguro('10.0.0.1', PROD, naoDeveChamar)).rejects.toBeInstanceOf(DestinoBloqueadoError)
    await expect(resolverDestinoSeguro('sem-registro.exemplo.com', PROD, dns())).rejects.toMatchObject({ motivo: 'DNS_SEM_RESULTADO' })
    await expect(resolverDestinoSeguro('falha.exemplo.com', PROD, naoDeveChamar)).rejects.toMatchObject({ motivo: 'DNS_SEM_RESULTADO' })
  })
})

describe('os canais conectam no IP VALIDADO e recusam destino proibido antes de abrir conexão', () => {
  const evento: EventoDeAlerta = { alerta: 'payment_void_manual_review', severidade: 'CRITICO', servico: 'api', ambiente: 'test', em: '2026-10-05T12:00:00.000Z', mensagem: 'x', contexto: {}, ocorrenciasSuprimidas: 0 }
  const evo = (politica: PoliticaDeDestino, baseUrl: string): ConfigWhatsappEvolution => ({
    provedor: 'evolution', baseUrl, instancia: 'inst', apikey: 'APIKEY-X', versao: 2, para: ['5511999999999'], minSeveridade: 'CRITICO', origem: 'database', politicaDeDestino: politica,
  })

  it('WhatsApp: resolve UMA vez, conecta no IP resolvido com Host/SNI do nome original (rebinding não troca o destino depois da checagem)', async () => {
    const chamadas: string[] = []
    let resolucoes = 0
    const dns: ResolvedorDns = async () => {
      resolucoes++
      return [{ address: '203.0.113.9', family: 4 }]
    }
    const requisitor: RequisitorHttp = async (opcoes) => {
      chamadas.push(`${opcoes.protocolo}//${opcoes.host}:${opcoes.port}${opcoes.path} Host=${(opcoes.headers as Record<string, string>).Host} sni=${opcoes.servername}`)
      return { status: 201 }
    }
    await criarCanalEvolution(evo(PROD, 'https://evolution.exemplo.com.br'), { dns, requisitor }).enviar(evento)
    expect(resolucoes).toBe(1)
    expect(chamadas).toEqual(['https://203.0.113.9:443/message/sendText/inst Host=evolution.exemplo.com.br sni=evolution.exemplo.com.br'])
  })

  it('WhatsApp: nome público que resolve para interno => FalhaDeCanal "destino bloqueado", e o requisitor NEM é chamado', async () => {
    let chamou = false
    const requisitor: RequisitorHttp = async () => {
      chamou = true
      return { status: 201 }
    }
    const dns: ResolvedorDns = async () => [{ address: '10.0.0.5', family: 4 }]
    await expect(criarCanalEvolution(evo(PROD, 'https://evolution.exemplo.com.br'), { dns, requisitor }).enviar(evento)).rejects.toMatchObject({ canal: 'whatsapp', motivo: 'destino bloqueado (REDE_PRIVADA)' })
    expect(chamou).toBe(false)
  })

  it('E-mail: o transporte recebe o IP validado (host original só como SNI); destino interno em produção nunca cria transporte', async () => {
    const config = (host: string): ConfigEmail => ({ para: ['a@b.com'], de: 'x@y.com', host, porta: 587, secure: false, exigirTls: true, minSeveridade: 'IMPORTANTE', origem: 'database', politicaDeDestino: PROD })
    const usados: Array<{ host: string; ip: string }> = []
    const criarTransporte = (o: { host: string; ip: string }) => {
      usados.push({ host: o.host, ip: o.ip })
      return { sendMail: async () => ({}) }
    }
    await criarCanalEmail(config('smtp.exemplo.com'), { dns: async () => [{ address: '203.0.113.20', family: 4 }], criarTransporte }).enviar(evento)
    expect(usados).toEqual([{ host: 'smtp.exemplo.com', ip: '203.0.113.20' }])
    usados.length = 0
    await expect(criarCanalEmail(config('smtp.exemplo.com'), { dns: async () => [{ address: '127.0.0.1', family: 4 }], criarTransporte }).enviar(evento)).rejects.toBeInstanceOf(FalhaDeCanal)
    await expect(criarCanalEmail(config('169.254.169.254'), { criarTransporte }).enviar(evento)).rejects.toMatchObject({ motivo: 'destino bloqueado (ENDERECO_DE_METADADOS)' })
    expect(usados).toEqual([])
  })
})
