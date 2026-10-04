import { describe, expect, it } from "vitest"
import {
  CTA_LINKS,
  FAQ_ITEMS,
  FEATURES,
  HERO_POINTS,
  BENEFITS,
  NAV_ANCHORS,
  STAT_FACTS,
  TOUR_STEPS,
  TRUST_ITEMS,
} from "./landing-data"

/** Todo texto visível de produto da landing, achatado, para varrer com as regras de conteúdo. */
function allCopy(): string[] {
  return [
    ...HERO_POINTS.map((p) => p.text),
    ...STAT_FACTS.flatMap((s) => [s.value, s.label, s.detail]),
    ...TOUR_STEPS.flatMap((s) => [s.title, s.text]),
    ...BENEFITS.flatMap((s) => [s.title, s.text, s.where]),
    ...FEATURES.flatMap((s) => [s.title, s.text, s.note ?? ""]),
    ...TRUST_ITEMS.flatMap((s) => [s.title, s.text]),
    ...FAQ_ITEMS.flatMap((s) => [s.q, s.a]),
  ]
}

describe("conteúdo da landing — regra de ouro (só afirma o que o produto faz hoje)", () => {
  it("toda afirmação tem a prova (arquivo/rota) que a comprova", () => {
    const withProof = [...HERO_POINTS, ...STAT_FACTS, ...TOUR_STEPS, ...BENEFITS, ...FEATURES, ...TRUST_ITEMS, ...FAQ_ITEMS]
    for (const item of withProof) expect(item.proof.trim().length).toBeGreaterThan(8)
  })

  it("nunca diz que o pagamento por Pix/cartão já funciona: toda menção vem com 'em breve'", () => {
    for (const text of allCopy()) {
      if (/(?<![\p{L}])(pix|cart[aã]o)(?![\p{L}])/iu.test(text)) {
        expect(text.toLowerCase(), `menciona Pix/cartão sem "em breve": ${text}`).toContain("em breve")
      }
    }
  })

  it("não traz preços, depoimentos, avaliações, certificações nem contato inventado", () => {
    const joined = allCopy().join("\n")
    expect(joined).not.toMatch(/R\$\s?\d/)
    expect(joined).not.toMatch(/[★⭐]/)
    expect(joined).not.toMatch(/depoiment|avalia[cç][aã]o|certifica|pr[eê]mio|iso\s?\d|pci/i)
    expect(joined).not.toMatch(/\d{4,5}-?\d{4}/)
    expect(joined).not.toMatch(/@\w+\.\w+/)
    expect(joined).not.toMatch(/whatsapp|telefone|e-mail/i)
  })

  // MUDOU (foco no motorista, 04/10/2026): o 3º fato era "OCPP 1.6-J" (protocolo do carregador, assunto de operador);
  // agora são "Ao vivo" (a recarga do motorista) e "Sem loja" (app instalável/PWA).
  it("a faixa de números só usa fatos verificáveis do ponto de vista do motorista (3 conectores, 1 conta, ao vivo, sem loja)", () => {
    expect(STAT_FACTS.map((s) => s.id)).toEqual(["conectores", "conta", "ao-vivo", "sem-loja"])
    expect(STAT_FACTS.find((s) => s.id === "conectores")?.count).toBe(3)
    expect(STAT_FACTS.find((s) => s.id === "conta")?.count).toBe(1)
  })

  it("as três etapas de conector citadas existem no texto (AC Tipo 2, DC CCS2, DC CHAdeMO)", () => {
    const detail = STAT_FACTS.find((s) => s.id === "conectores")?.detail ?? ""
    expect(detail).toContain("AC Tipo 2")
    expect(detail).toContain("DC CCS2")
    expect(detail).toContain("DC CHAdeMO")
  })

  it("o tour do motorista tem as cinco etapas na ordem pedida", () => {
    expect(TOUR_STEPS.map((s) => s.id)).toEqual(["mapa", "qr", "iniciar", "carregando", "recibo"])
  })

  it("ids únicos e âncoras de navegação bem formadas", () => {
    for (const list of [STAT_FACTS, TOUR_STEPS, BENEFITS, FEATURES, TRUST_ITEMS]) {
      const ids = list.map((i) => i.id)
      expect(new Set(ids).size).toBe(ids.length)
    }
    for (const a of NAV_ANCHORS) expect(a.href).toMatch(/^#[a-z-]+$/)
    expect(new Set(NAV_ANCHORS.map((a) => a.href)).size).toBe(NAV_ANCHORS.length)
  })

  it("os CTAs apontam para rotas que existem (/eletropostos, /cadastro, /login)", () => {
    expect(CTA_LINKS).toEqual({ eletropostos: "/eletropostos", cadastro: "/cadastro", login: "/login" })
  })

  // NOVO (04/10/2026): a landing fala com quem USA o carro elétrico. Nenhum texto de produto pode voltar a falar com a
  // empresa que opera eletropostos (painel, relatórios, comandos remotos, perfis de acesso, trilha de auditoria...).
  it("não fala com a empresa operadora: nada de painel, relatórios, financeiro do operador, auditoria, OCPP ou comandos remotos", () => {
    const joined = allCopy().join("\n")
    expect(joined).not.toMatch(/painel|relat[oó]rio|dashboard|auditoria|ocpp|csv|reinici|destrav|perfis? de acesso|para quem opera|seu eletroposto|operar com/i)
    expect(joined).not.toMatch(/faturamento|ticket m[eé]dio|taxa de ociosidade|cadastre (pontos|carregadores)/i)
    for (const a of NAV_ANCHORS) expect(a.label.toLowerCase()).not.toContain("opera")
  })

  // NOVO: não existe filtro AC/DC nem reserva no produto - a landing não pode prometer nenhum dos dois.
  it("não promete o que o produto não tem: filtro AC/DC, reserva de conector, avisos push, mapa em tempo real garantido", () => {
    const joined = allCopy().join("\n")
    expect(joined).not.toMatch(/filtr(e|ar|o) (por )?(ac|dc|conector|pot[eê]ncia)/i)
    expect(joined).not.toMatch(/reserve|reservar|agende|notifica[cç][aã]o|push/i)
  })

  it("a ordem das âncoras acompanha a narrativa do motorista", () => {
    expect(NAV_ANCHORS.map((a) => a.href)).toEqual(["#como-funciona", "#vantagens", "#recursos", "#seguranca", "#perguntas"])
  })

  it("os benefícios e a FAQ do motorista cobrem o essencial pedido (tarifa antes, parar a recarga, conta única, PWA, localização)", () => {
    const benefits = BENEFITS.map((b) => b.id)
    for (const id of ["chegar-sabendo", "custo-previsivel", "controle", "uma-conta", "historico", "sem-loja"]) expect(benefits).toContain(id)
    const questions = FAQ_ITEMS.map((f) => f.q).join("\n")
    for (const re of [/baixar um aplicativo/, /come[cç]o uma recarga/, /pago a recarga/, /est[aá] livre/, /conectores/, /localiza[cç][aã]o/]) expect(questions).toMatch(re)
  })
})
