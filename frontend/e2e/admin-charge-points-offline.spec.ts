import { expect, test, type Page } from "@playwright/test"
import AxeBuilder from "@axe-core/playwright"

/**
 * Rótulo "Offline" na célula Status da lista de carregadores do Admin (decisão do dono, 05/10/2026). Contra o mock MSW: `online` é valor fixo por carregador (`mocks/data.ts`:
 * cp_1/cp_2/cp_3 online; cp_4 `CP-OUTLET-CAMPINAS-01` e cp_5 `CP-ANHANGUERA-01` offline). NADA aqui foi provado contra o backend real.
 * Regra: o rótulo só aparece com `online === false` E cadastro ativo; sem coluna nova; ponto + texto (não só cor).
 */

async function loginAndOpen(page: Page) {
  await page.goto("/login")
  await page.getByLabel("E-mail").fill("admin@innoelektron.com")
  await page.getByLabel("Senha").fill("senha1234")
  await page.getByRole("button", { name: "Entrar" }).click()
  await expect(page).toHaveURL(/\/admin\/dashboard/)
  await page.goto("/admin/charge-points")
  await expect(page.getByRole("cell", { name: "CP-VILA-NORTE-01", exact: true })).toBeVisible()
}

const rowOf = (page: Page, ocpp: string) => page.getByRole("row").filter({ has: page.getByRole("cell", { name: ocpp, exact: true }) })

for (const viewport of [
  { name: "mobile (375px)", width: 375, height: 812 },
  { name: "tablet (768px)", width: 768, height: 1024 },
  { name: "desktop (1440px)", width: 1440, height: 900 },
]) {
  test.describe(`Admin > Carregadores - Offline - ${viewport.name}`, () => {
    test.use({ viewport: { width: viewport.width, height: viewport.height } })

    test("só os offline ATIVOS ganham o rótulo, dentro da célula Status, sem coluna nova e com o custo de altura medido", async ({ page }) => {
      await loginAndOpen(page)
      const headers = await page.getByRole("columnheader").allTextContents()
      expect(headers).toEqual(["Identidade OCPP", "Fabricante/Modelo", "Site", "Conectores", "Tarifa", "Status", "Ações"]) // nenhuma coluna nova

      for (const ocpp of ["CP-OUTLET-CAMPINAS-01", "CP-ANHANGUERA-01"]) {
        const mark = rowOf(page, ocpp).getByTestId("cp-offline")
        await expect(mark).toHaveText("Offline")
        // Dentro da MESMA célula do badge "Ativo".
        const cell = rowOf(page, ocpp).getByRole("cell").nth(5)
        await expect(cell).toContainText("Ativo")
        await expect(cell.getByTestId("cp-offline")).toHaveCount(1)
      }
      for (const ocpp of ["CP-VILA-NORTE-01", "CP-ESTRADA-REAL-01", "CP-BARRA-FUNDA-01"]) {
        await expect(rowOf(page, ocpp).getByTestId("cp-offline")).toHaveCount(0)
      }
      await expect(page.getByTestId("cp-offline")).toHaveCount(2)

      // Medido: o rótulo cabe na célula e custa no máximo UMA linha de texto na altura da linha (a célula Status é estreita: com pouco espaço o rótulo quebra para baixo do badge).
      // Abaixo de 1024 px a linha já é mais alta por causa das outras células (delta 0); em 1440 px o custo medido é +8 px nas linhas offline.
      const heightOf = async () => (await rowOf(page, "CP-OUTLET-CAMPINAS-01").boundingBox())!.height
      const withMark = await heightOf()
      await page.addStyleTag({ content: "[data-testid=cp-offline]{display:none!important}" })
      const withoutMark = await heightOf()
      expect(withMark - withoutMark).toBeLessThanOrEqual(10)
      if (viewport.width < 1024) expect(withMark - withoutMark).toBeLessThanOrEqual(1)
      await page.reload()
      await expect(page.getByRole("cell", { name: "CP-VILA-NORTE-01", exact: true })).toBeVisible()
      expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBe(0) // o rótulo não cria rolagem lateral da página
      const cellBox = await rowOf(page, "CP-OUTLET-CAMPINAS-01").getByRole("cell").nth(5).boundingBox()
      const markBox = await rowOf(page, "CP-OUTLET-CAMPINAS-01").getByTestId("cp-offline").boundingBox()
      expect(markBox!.x + markBox!.width).toBeLessThanOrEqual(cellBox!.x + cellBox!.width + 0.5)
      expect(markBox!.y).toBeGreaterThanOrEqual(cellBox!.y)
      expect(markBox!.y + markBox!.height).toBeLessThanOrEqual(cellBox!.y + cellBox!.height + 0.5)

      const violations = (await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze()).violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(" | ")}`)
      expect(violations).toEqual([])
    })
  })
}

test.describe("Admin > Carregadores - Offline - inativo", () => {
  test.use({ viewport: { width: 1440, height: 900 } })

  test("desativar um carregador offline tira o rótulo (vira só 'Inativo')", async ({ page }) => {
    await loginAndOpen(page)
    await expect(rowOf(page, "CP-OUTLET-CAMPINAS-01").getByTestId("cp-offline")).toBeVisible()
    await page.getByRole("button", { name: "Desativar CP-OUTLET-CAMPINAS-01" }).click()
    await page.getByRole("dialog").getByRole("button", { name: "Desativar" }).click()
    const row = rowOf(page, "CP-OUTLET-CAMPINAS-01")
    await expect(row.getByText("Inativo", { exact: true })).toBeVisible()
    await expect(row.getByTestId("cp-offline")).toHaveCount(0)
    await expect(page.getByTestId("cp-offline")).toHaveCount(1) // sobrou só o cp_5
  })
})
