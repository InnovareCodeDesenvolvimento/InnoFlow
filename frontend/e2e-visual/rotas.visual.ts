import { expect, test } from "@playwright/test"
import path from "node:path"
import { PASTA_AUTH, PERSONAS, type Persona } from "./constantes"
import { aguardarEstavel, fotografar, prepararPagina } from "./estabilizar"
import { ROTAS } from "./rotas"

/**
 * Uma foto por rota × viewport (projeto 375/768/1440). Compara com `e2e-visual/baseline/<plataforma>/<viewport>/<id>.jpg`.
 * Mudança visual INTENCIONAL: ver política de atualização no `e2e-visual/README.md` — não regrave a baseline para "passar".
 */
const personas: Persona[] = ["anon", "driver", "travado", "admin"]

for (const persona of personas) {
  test.describe(`rotas — ${persona}`, () => {
    test.use({
      storageState: persona === "anon" ? { cookies: [], origins: [] } : path.join(PASTA_AUTH, `${PERSONAS[persona].arquivo}.json`),
    })

    for (const rota of ROTAS.filter((r) => r.persona === persona)) {
      test(`${rota.id} (${rota.path})`, async ({ page }) => {
        await prepararPagina(page)
        await page.goto(rota.path, { waitUntil: "load" })
        await aguardarEstavel(page, rota.pronto)
        const foto = await fotografar(page, { crescerAteODocumento: rota.crescerAteODocumento, nome: rota.id })
        // Modo SONDA (VISUAL_GEO_DIR): só coleta DOM+imagem para `scripts/comparar-geometria.mjs`; não compara com a baseline (senão o 1º diff aborta o fluxo de várias telas).
        if (!process.env.VISUAL_GEO_DIR) expect(foto).toMatchSnapshot(`${rota.id}.jpg`)
      })
    }
  })
}
