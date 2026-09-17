import pkg from "./package.json" with { type: "json" }

/**
 * Identificação do build, injetada em tempo de compilação.
 *
 * Fica fora de `src/` de propósito: é lida pela CONFIG (vite.config.ts), que
 * roda no Node. Assim o `package.json` inteiro nunca entra no bundle do
 * navegador — só as duas strings abaixo.
 *
 * Mesmo padrão do projeto irmão ParquedasFeiras (`frontend/buildInfo.ts`
 * lá) — aqui simplificado porque o InnoElektron não é white-label (não tem
 * VITE_APP_NAME por cliente para achatar no bundle).
 */
export const buildDefine = {
  __APP_VERSION__: JSON.stringify(pkg.version),
  // Data do build (UTC, AAAA-MM-DD). Serve ao suporte: "versão 0.1.0 de que dia?"
  __BUILD_DATE__: JSON.stringify(new Date().toISOString().slice(0, 10)),
}
