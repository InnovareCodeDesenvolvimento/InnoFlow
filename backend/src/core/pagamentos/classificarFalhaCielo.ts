/**
 * Taxonomia das falhas HTTP da Cielo (F3/F4/F6, C2.2) — pura. Existe para que "credencial errada", "IP de saída fora da lista" e "Cielo fora do ar"
 * deixem de ser o mesmo `Cielo respondeu HTTP N`: o admin precisa saber O QUE consertar (e, no 403, NÃO apagar uma credencial que está certa). Fonte:
 * `api.ts` do Parque das Feiras (produção) e a sonda de 01/09/2026 registrada lá.
 *
 *  - CREDENCIAL: HTTP 401, ou HTTP **400** com a lista `[{Code, Message}]` da Cielo trazendo 101/131/132/138/139/140 — a Cielo NÃO devolve 401 para
 *    credencial errada. Rede de segurança: a MENSAGEM citando "MerchantId"/"MerchantKey" também vale (os códigos do sandbox não são os da produção).
 *    Lembrete: sandbox e produção são servidores SEPARADOS; credencial de um é recusada no outro com o MESMO erro de uma credencial errada.
 *  - IP_NAO_PERMITIDO: HTTP 403 — causa mais comum é o IP de saída desta API fora da lista de "IPs confiáveis" do Site Cielo, e não credencial revogada.
 *  - LIMITE_DE_CHAMADAS: 429. INDISPONIVEL: 5xx (e, fora daqui, timeout/rede). NAO_ENCONTRADO: 404 (na consulta: id inexistente ou fora da janela de 3 meses).
 *  - REQUISICAO_RECUSADA: qualquer outro 4xx — defeito NOSSO de payload, não credencial.
 *
 * Os `Message` da Cielo são lidos só para o teste de regex e NUNCA devolvidos (podem ecoar dado do pagador); só os códigos numéricos saem.
 */
export type TipoFalhaCielo = 'CREDENCIAL' | 'IP_NAO_PERMITIDO' | 'LIMITE_DE_CHAMADAS' | 'INDISPONIVEL' | 'NAO_ENCONTRADO' | 'REQUISICAO_RECUSADA'

export interface FalhaCieloClassificada {
  tipo: TipoFalhaCielo
  /** Códigos numéricos da lista de erros da Cielo (sem as mensagens). */
  codigos: number[]
}

const CODIGOS_DE_CREDENCIAL: ReadonlySet<number> = new Set([101, 131, 132, 138, 139, 140])
const MENSAGEM_DE_CREDENCIAL = /merchant[ ]*(id|key)/i

interface ErroLido {
  codigo: number | null
  mensagem: string
}

function lerErros(corpo: unknown): ErroLido[] {
  if (!Array.isArray(corpo)) return []
  return corpo.flatMap((e): ErroLido[] => {
    if (e === null || typeof e !== 'object') return []
    const { Code, Message } = e as { Code?: unknown; Message?: unknown }
    const codigo = typeof Code === 'number' && Number.isInteger(Code) ? Code : typeof Code === 'string' && /^[0-9]{1,6}$/.test(Code.trim()) ? Number(Code.trim()) : null
    return [{ codigo, mensagem: typeof Message === 'string' ? Message : '' }]
  })
}

export function classificarFalhaHttpCielo(httpStatus: number, corpo: unknown): FalhaCieloClassificada {
  const erros = lerErros(corpo)
  const codigos = erros.flatMap((e) => (e.codigo === null ? [] : [e.codigo]))

  if (httpStatus === 401) return { tipo: 'CREDENCIAL', codigos }
  if (httpStatus === 403) return { tipo: 'IP_NAO_PERMITIDO', codigos }
  if (httpStatus === 429) return { tipo: 'LIMITE_DE_CHAMADAS', codigos }
  if (httpStatus >= 500) return { tipo: 'INDISPONIVEL', codigos }
  if (httpStatus === 404) return { tipo: 'NAO_ENCONTRADO', codigos }
  if (httpStatus === 400 && erros.some((e) => (e.codigo !== null && CODIGOS_DE_CREDENCIAL.has(e.codigo)) || MENSAGEM_DE_CREDENCIAL.test(e.mensagem))) {
    return { tipo: 'CREDENCIAL', codigos }
  }
  return { tipo: 'REQUISICAO_RECUSADA', codigos }
}

/**
 * Texto para o ADMIN (log/diagnóstico) — nunca para o motorista, que continua vendo o 503 genérico. Sem corpo cru, sem segredo.
 * O texto do 403 existe de propósito: sem ele o admin apaga a credencial certa tentando consertar um bloqueio de rede.
 */
export function mensagemDeFalhaCielo(falha: FalhaCieloClassificada, httpStatus: number): string {
  const codigos = falha.codigos.length > 0 ? ` (códigos ${falha.codigos.join(', ')})` : ''
  switch (falha.tipo) {
    case 'CREDENCIAL':
      return `Cielo respondeu HTTP ${httpStatus}: credencial recusada${codigos}. Confira MerchantId e MerchantKey e o AMBIENTE (sandbox e produção são servidores separados: a credencial de um é recusada no outro com este mesmo erro).`
    case 'IP_NAO_PERMITIDO':
      return `Cielo respondeu HTTP 403: acesso recusado${codigos}. Causa mais comum: o IP de saída desta API não está na lista de IPs confiáveis do Site Cielo — confira isso ANTES de trocar ou apagar a credencial (ela pode estar correta).`
    case 'LIMITE_DE_CHAMADAS':
      return `Cielo respondeu HTTP 429: excesso de chamadas${codigos}. Aguarde e tente de novo.`
    case 'INDISPONIVEL':
      return `Cielo respondeu HTTP ${httpStatus}: serviço indisponível${codigos}.`
    case 'NAO_ENCONTRADO':
      return `Cielo respondeu HTTP 404: recurso não encontrado${codigos} (em consulta de venda: id inexistente ou fora da janela de 3 meses).`
    case 'REQUISICAO_RECUSADA':
      return `Cielo respondeu HTTP ${httpStatus}: requisição recusada${codigos}. Provável defeito de payload nosso, não de credencial.`
  }
}
