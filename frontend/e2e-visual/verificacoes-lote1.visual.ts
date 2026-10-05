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
    test(`aba ${aba}: o h2 do 1º card tem largura útil (>= 160 px)`, async ({ page }) => {
      // Corrigido pela Lyra (05/10/2026): abaixo de `sm` os selos vão para uma linha própria. Regressão travada também em `verificacoes-configuracoes.visual.ts` (2b e 2).
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
