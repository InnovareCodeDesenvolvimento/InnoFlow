/**
 * Baixa um objeto como arquivo JSON legível (2 espaços) pelo navegador, sem rota nem servidor de arquivos: `Blob` -> URL temporária -> clique em um `<a download>`.
 * A URL é revogada logo depois (o arquivo já foi entregue ao navegador) para o conteúdo - aqui, dado pessoal - não ficar na memória da página.
 * O `<a>` não é inserido no documento: em navegadores atuais o clique programático funciona assim, e nada fica no DOM.
 */
export function downloadJson(data: unknown, filename: string): void {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json;charset=utf-8" })
  const url = URL.createObjectURL(blob)
  try {
    const link = document.createElement("a")
    link.href = url
    link.download = filename
    link.rel = "noopener"
    link.click()
  } finally {
    // O download já foi iniciado de forma síncrona; um instante depois a URL pode ser solta com segurança.
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  }
}
