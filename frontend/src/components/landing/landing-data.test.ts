import { describe, expect, it } from "vitest"
import {
  CTA_LINKS,
  FAQ_ITEMS,
  FEATURES,
  HERO_POINTS,
  NAV_ANCHORS,
  OPERATOR_AREAS,
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
    ...OPERATOR_AREAS.flatMap((s) => [s.title, s.text]),
    ...FEATURES.flatMap((s) => [s.title, s.text, s.note ?? ""]),
    ...TRUST_ITEMS.flatMap((s) => [s.title, s.text]),
    ...FAQ_ITEMS.flatMap((s) => [s.q, s.a]),
  ]
}

describe("conteúdo da landing — regra de ouro (só afirma o que o produto faz hoje)", () => {
  it("toda afirmação tem a prova (arquivo/rota) que a comprova", () => {
    const withProof = [...HERO_POINTS, ...STAT_FACTS, ...TOUR_STEPS, ...OPERATOR_AREAS, ...FEATURES, ...TRUST_ITEMS, ...FAQ_ITEMS]
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

  it("a faixa de números só usa fatos verificáveis (3 conectores, 1 conta, OCPP 1.6-J, tempo real)", () => {
    expect(STAT_FACTS.map((s) => s.id)).toEqual(["conectores", "conta", "ocpp", "tempo-real"])
    expect(STAT_FACTS.find((s) => s.id === "conectores")?.count).toBe(3)
    expect(STAT_FACTS.find((s) => s.id === "ocpp")?.value).toBe("OCPP 1.6-J")
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
    for (const list of [STAT_FACTS, TOUR_STEPS, OPERATOR_AREAS, FEATURES, TRUST_ITEMS]) {
      const ids = list.map((i) => i.id)
      expect(new Set(ids).size).toBe(ids.length)
    }
    for (const a of NAV_ANCHORS) expect(a.href).toMatch(/^#[a-z-]+$/)
    expect(new Set(NAV_ANCHORS.map((a) => a.href)).size).toBe(NAV_ANCHORS.length)
  })

  it("os CTAs apontam para rotas que existem (/eletropostos, /cadastro, /login)", () => {
    expect(CTA_LINKS).toEqual({ eletropostos: "/eletropostos", cadastro: "/cadastro", login: "/login" })
  })
})
