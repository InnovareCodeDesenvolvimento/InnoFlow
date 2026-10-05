import { expect, test } from "@playwright/test"
import path from "node:path"
import { PASTA_AUTH, PERSONAS } from "./constantes"
import { aguardarEstavel, prepararPagina } from "./estabilizar"

/**
 * Verificações da Íris sobre o lote 1 (05/10/2026) que a FOTO não prova. Não gravam baseline.
 * Rodar: `npx playwright test --config playwright.visual.config.ts verificacoes-lote1 --update-snapshots=none`.
 */

test.describe("Configurações: o título do cabeçalho de cada card não pode ser espremido pelos selos", () => {
  test.use({ storageState: path.join(PASTA_AUTH, `${PERSONAS.admin.arquivo}.json`) })

  for (const aba of ["geral", "email", "whatsapp"] as const) {
    test(`aba ${aba}: o h2 do 1º card tem largura útil (>= 160 px)`, async ({ page }, info) => {
      // DEFEITO MEDIDO (05/10/2026, 46cd153): a 375 px o selo "VEM DO SERVIDOR ..." / "NÃO CONFIGURADO" não quebra linha e empurra o título para uma coluna de 0 a 109 px
      // (Geral: h2 "Dados da empresa" com 0 px de largura; E-mail 80 px; WhatsApp 109 px, num card de 303 px). A 768 e 1440 fica tudo bem. Remova o `fail` quando a Lyra corrigir.
      test.fail(info.project.name === "375", "título do card espremido pelos selos a 375 px (Lyra)")
      await prepararPagina(page)
      await page.goto(`/admin/configuracoes/${aba}`, { waitUntil: "load" })
      await aguardarEstavel(page)
      const m = await page.evaluate(() => {
        const h2 = document.querySelector("main h2")!
        return { h2: Math.round(h2.getBoundingClientRect().width * 10) / 10, texto: (h2.textContent ?? "").trim() }
      })
      expect(m.h2, `h2 "${m.texto}" mede ${m.h2} px`).toBeGreaterThanOrEqual(160)
    })
  }
})
