import { expect, test, type Locator, type Page } from "@playwright/test"
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
  await aguardarLayoutAssentar(page)
}

/**
 * Espera o layout do catálogo ASSENTAR: o topo e a altura de TODAS as seções (e a altura do documento) iguais por 1 s (10 amostras de 100 ms). Sem isso, sob carga (3 workers), uma seção
 * alta ("ErrorState e LoadingScreen", "404 e erro de tela inteira") era fotografada com o recorte medido ANTES de uma imagem/fonte terminar de assentar — conteúdo deslocado ~34 px em
 * 2 de 45 fotos por execução, em seções diferentes a cada vez.
 */
async function aguardarLayoutAssentar(page: Page) {
  const assinatura = () =>
    page.evaluate(
      () =>
        [...document.querySelectorAll("section[aria-label]")]
          .map((s) => {
            const r = s.getBoundingClientRect()
            return `${Math.round((r.top + window.scrollY) * 10)}:${Math.round(r.height * 10)}`
          })
          .join("|") + `#${document.documentElement.scrollHeight}`,
    )
  let ultima = ""
  let iguais = 0
  for (let i = 0; i < 80 && iguais < 10; i++) {
    const atual = await assinatura()
    iguais = atual === ultima ? iguais + 1 : 0
    ultima = atual
    await page.waitForTimeout(100)
  }
  expect(iguais, "o layout do catálogo não assentou em 8 s").toBeGreaterThanOrEqual(10)
}

/**
 * REGRA: nunca pedir ao Playwright uma foto MAIS ALTA QUE A JANELA. Para fotografar um elemento maior que a janela ele rola e captura além dela, e as unidades `svh` (`min-h-[56svh]`
 * do LoadingScreen inline, `min-h-[60svh]` do ErrorState) mudam no meio da captura: o card saía com 420 px numa foto e 455 px na outra e o recorte deslocado (1 px ou 34–36 px, o título da
 * seção cortado numa foto e inteiro na outra). Medido contra uma baseline gravada instantes antes: 1 a 4 dos 45 testes falhavam POR EXECUÇÃO, sempre nas seções que passam da janela
 * a 375 px ("ErrorState e LoadingScreen" 1.819 px, "404 e erro de tela inteira" 1.584 px e "Estados vazios", 826 px numa janela de 812). NÃO resolveram: alinhar à grade de pixels, esperar o
 * layout assentar, fixar a rolagem, `fullPage`+`clip` (piorou: 16 de 45) nem afrouxar o limiar. Resolve: seção mais alta que a janela é fotografada em BLOCOS (cada filho direto; se
 * ainda for mais alto, os filhos dele). A conta é por viewport: a mesma seção pode ser uma foto a 1440 e vários blocos a 375.
 */
const MARGEM_DA_JANELA = 8

/**
 * Foto de um bloco ALINHADA À GRADE DE PIXELS. A posição de cada seção no documento é FRACIONÁRIA (ex.: 6466,2 px: as alturas dos blocos de texto acumulam décimos) e varia de um
 * carregamento para outro com a métrica da fonte; um `translate` de menos de 1 px leva o topo e a esquerda do bloco a coordenadas inteiras sem mudar o layout. A rolagem também é
 * fixada (topo do bloco no topo da janela, inteira e instantânea) antes do Playwright fotografar.
 */
async function fotografarSecao(secao: Locator) {
  await secao.scrollIntoViewIfNeeded()
  await secao.evaluate((el) => {
    const e = el as HTMLElement
    e.style.transform = ""
    const r = e.getBoundingClientRect()
    const x = r.left + window.scrollX
    const y = r.top + window.scrollY
    e.style.transform = `translate(${(Math.round(x) - x).toFixed(3)}px, ${(Math.round(y) - y).toFixed(3)}px)`
    // Topo da seção no topo da janela, em rolagem inteira e instantânea: o Playwright rola sozinho até o elemento antes de fotografar; numa seção mais alta que a janela essa rolagem
    // caía em duas posições (diferença de 34 px medida) e o recorte saía deslocado — o título da seção cortado numa foto, inteiro na outra.
    window.scrollTo({ top: Math.round(y), left: 0, behavior: "instant" })
  })
  await secao.page().evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(null)))))
  return secao.screenshot({ animations: "disabled", type: "jpeg", quality: 70 })
}

/**
 * Fotografa `alvo` em blocos que cabem na janela: filho a filho, e descendo mais um nível quando um filho ainda é mais alto que a janela (ex.: a grade de 2 `LoadingScreen` empilhada a
 * 375 px = 925 px numa janela de 812). O nome do arquivo carrega o caminho (`-1`, `-4-2`...). Determinístico: a estrutura do DOM e a altura da janela são fixas.
 */
async function fotografarEmBlocos(page: Page, alvo: Locator, prefixo: string): Promise<{ arquivo: string; buffer: Buffer }[]> {
  const janela = page.viewportSize()!.height
  const filhos = alvo.locator(":scope > *")
  const n = await filhos.count()
  const saida: { arquivo: string; buffer: Buffer }[] = []
  for (let i = 0; i < n; i++) {
    const filho = filhos.nth(i)
    const altura = (await filho.boundingBox())!.height
    const nome = `${prefixo}-${i + 1}`
    if (altura > janela - MARGEM_DA_JANELA) saida.push(...(await fotografarEmBlocos(page, filho, nome)))
    else saida.push({ arquivo: `${nome}.jpg`, buffer: await fotografarSecao(filho) })
  }
  return saida
}

test.describe("catálogo /__ds", () => {
  for (const nome of SECOES) {
    test(`seção: ${nome}`, async ({ page }) => {
      await abrir(page)
      const secao = page.locator(`section[aria-label="${nome}"]`)
      const altura = (await secao.boundingBox())!.height
      if (altura > page.viewportSize()!.height - MARGEM_DA_JANELA) {
        const fotos = await fotografarEmBlocos(page, secao, `ds-${slug(nome)}`)
        expect(fotos.length, `blocos de "${nome}"`).toBeGreaterThanOrEqual(2)
        for (const { arquivo, buffer } of fotos) expect(buffer).toMatchSnapshot(arquivo)
        return
      }
      expect(await fotografarSecao(secao)).toMatchSnapshot(`ds-${slug(nome)}.jpg`)
    })
  }

  test("estados: hover do botão lima e foco por teclado do campo", async ({ page }) => {
    await abrir(page)
    const secao = page.locator('section[aria-label="Estados e sobreposições"]')
    await secao.scrollIntoViewIfNeeded()
    await secao.locator('[data-ds="botao-lima"]').hover()
    expect(await fotografarSecao(secao)).toMatchSnapshot("ds-estado-hover-lima.jpg")
    await page.mouse.move(0, 0)
    await secao.locator('[data-ds="botao-lima"]').focus()
    await page.keyboard.press("Tab") // modalidade teclado; segue para o botão petróleo
    await secao.locator('[data-ds="campo-normal"]').focus()
    expect(await fotografarSecao(secao)).toMatchSnapshot("ds-estado-foco-campo.jpg")
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
