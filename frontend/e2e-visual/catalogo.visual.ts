import { expect, test, type Page } from "@playwright/test"
import { prepararPagina } from "./estabilizar"

/**
 * BASELINE DO CATÁLOGO DO DESIGN SYSTEM (`/__ds`, F-F). Fora do `npm run test:visual` (que roda só `rotas estados`): rodar com `npm run test:visual:catalogo`, e gravar com
 * `npm run test:visual:catalogo:update` — a Íris grava e classifica; a Lyra só propõe. A rota existe SÓ em dev (`import.meta.env.DEV` em `App.tsx`; o harness usa o servidor
 * de desenvolvimento), então o catálogo NUNCA entra no build nem no precache do PWA (guarda estática em `src/test/catalogoFora.test.ts`; conferido também por grep no `dist/`).
 *
 * Uma foto por SEÇÃO (`section[aria-label]`) × 3 viewports, mais os estados que não são estáticos: hover do botão lima, foco por teclado do campo, diálogo aberto e toast.
 * Cada seção é fotografada isolada (elemento), então uma mudança de componente aparece só na seção dele.
 */
const SECOES = [
  "Tokens",
  "Botões",
  "Cards",
  "Badges e selos de ícone",
  "PageHeader e StatCard",
  "Tabela",
  "Estados vazios",
  "Campos e Segmented",
  "ErrorState e LoadingScreen",
  "Estados e sobreposições",
  "Skeleton",
  "Marca",
  "404 e erro de tela inteira",
] as const

const slug = (s: string) =>
  s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")

/**
 * NÃO usa `aguardarEstavel`: ele espera "sem esqueleto/spinner/aria-busy", e o catálogo MOSTRA de propósito esqueletos, spinners e botão carregando. A estabilidade vem de
 * `animations: "disabled"` + `reducedMotion` (config), da fonte Inter carregada e das imagens (mascote, lazy) completas antes de fotografar cada seção.
 */
async function abrir(page: Page) {
  await prepararPagina(page)
  await page.goto("/__ds", { waitUntil: "load" })
  await expect(page.getByRole("heading", { level: 1, name: "Design system InnoFlow" })).toBeVisible()
  const ok = await page.evaluate(async () => {
    await Promise.all(["400", "500", "600", "700", "800", "900"].map((w) => document.fonts.load(`${w} 16px Inter`, "AaÇãé0123 R$")))
    await document.fonts.ready
    // imagens preguiçosas: rola a página inteira para disparar o carregamento e espera todas terminarem
    for (let y = 0; y < document.documentElement.scrollHeight; y += 600) {
      window.scrollTo(0, y)
      await new Promise((r) => requestAnimationFrame(() => r(null)))
    }
    window.scrollTo(0, 0)
    await Promise.all(
      [...document.images]
        .filter((i) => i.getClientRects().length > 0)
        .map((i) =>
          i.complete ? Promise.resolve() : new Promise((r) => (i.addEventListener("load", r, { once: true }), i.addEventListener("error", r, { once: true }))),
        ),
    )
    return document.fonts.check("16px Inter", "AaÇãé0123 R$")
  })
  expect(ok, "a Inter precisa estar carregada (senão a foto sai com a fonte de reserva)").toBe(true)
}

test.describe("catálogo /__ds", () => {
  for (const nome of SECOES) {
    test(`seção: ${nome}`, async ({ page }) => {
      await abrir(page)
      const secao = page.locator(`section[aria-label="${nome}"]`)
      await secao.scrollIntoViewIfNeeded()
      expect(await secao.screenshot({ animations: "disabled", type: "jpeg", quality: 70 })).toMatchSnapshot(`ds-${slug(nome)}.jpg`)
    })
  }

  test("estados: hover do botão lima e foco por teclado do campo", async ({ page }) => {
    await abrir(page)
    const secao = page.locator('section[aria-label="Estados e sobreposições"]')
    await secao.scrollIntoViewIfNeeded()
    await secao.locator('[data-ds="botao-lima"]').hover()
    expect(await secao.screenshot({ animations: "disabled", type: "jpeg", quality: 70 })).toMatchSnapshot("ds-estado-hover-lima.jpg")
    await page.mouse.move(0, 0)
    await secao.locator('[data-ds="botao-lima"]').focus()
    await page.keyboard.press("Tab") // modalidade teclado; segue para o botão petróleo
    await secao.locator('[data-ds="campo-normal"]').focus()
    expect(await secao.screenshot({ animations: "disabled", type: "jpeg", quality: 70 })).toMatchSnapshot("ds-estado-foco-campo.jpg")
  })

  test("diálogo aberto (véu sem desfoque, raio de diálogo) e toast", async ({ page }) => {
    await abrir(page)
    const secao = page.locator('section[aria-label="Estados e sobreposições"]')
    await secao.scrollIntoViewIfNeeded()
    await secao.locator('[data-ds="abrir-dialogo"]').click()
    await expect(page.getByRole("dialog")).toBeVisible()
    expect(await page.screenshot({ animations: "disabled", type: "jpeg", quality: 70 })).toMatchSnapshot("ds-dialogo-aberto.jpg")
    await page.keyboard.press("Escape")
    await expect(page.getByRole("dialog")).toBeHidden()
    await secao.locator('[data-ds="abrir-toast"]').click()
    const toast = page.locator("[data-sonner-toast]").first()
    await expect(toast).toBeVisible()
    await page.waitForTimeout(600) // a entrada do sonner assenta
    expect(await toast.screenshot({ animations: "disabled", type: "jpeg", quality: 70 })).toMatchSnapshot("ds-toast.jpg")
  })
})
