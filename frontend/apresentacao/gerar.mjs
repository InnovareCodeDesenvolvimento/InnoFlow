/**
 * Gerador dos PDFs de apresentação do InnoFlow (Admin e Motorista). Reprodutível: sobe o app em modo mock (porta 5291),
 * captura as telas reais com o Playwright, monta os slides em HTML (1920x1080) e imprime os PDFs com o Chromium.
 *
 *   node apresentacao/gerar.mjs                      # tudo: capturas + os dois PDFs
 *   node apresentacao/gerar.mjs --so-pdf             # só remonta os PDFs com as capturas que já existem
 *   node apresentacao/gerar.mjs --so-capturas        # só as capturas (use --quais=id1,id2 para refazer algumas)
 *   node apresentacao/gerar.mjs --so=admin|motorista # um PDF só
 *   node apresentacao/gerar.mjs --gateway-pronto     # usa a captura da tela Gateway de pagamento (senão o slide fica "pendente")
 *
 * Rodar a partir de frontend/ (usa o Playwright e o Vite de frontend/node_modules). Saída: apresentacao/saida/*.pdf
 */
import { capturar } from "./capturar.mjs"
import { gerarPdf } from "./montar.mjs"
import admin from "./conteudo-admin.mjs"
import motorista from "./conteudo-motorista.mjs"

const args = process.argv.slice(2)
const flag = (n) => args.includes(`--${n}`)
const valor = (n) => args.find((a) => a.startsWith(`--${n}=`))?.split("=")[1]

const soPdf = flag("so-pdf")
const soCapturas = flag("so-capturas")
const quais = valor("quais")?.split(",")
const so = valor("so")
const gatewayPronto = flag("gateway-pronto")

if (!soPdf) {
  console.log("Capturando telas…")
  await capturar({ quais })
}
if (!soCapturas) {
  console.log("Gerando PDFs…")
  for (const c of [admin, motorista]) {
    if (so && so !== c.id) continue
    await gerarPdf(c, { gatewayPronto })
  }
}
