/**
 * Baixa um objeto como arquivo `.json` (Blob + `<a download>`): o dado já está em memória — veio de uma chamada autenticada (axios) — então não há navegação, nem token na URL.
 * Usado no dossiê do chargeback: formato aberto do servidor, que só oferecemos para baixar (anexar à resposta na Cielo).
 */
export function downloadJsonFile(filename: string, data: unknown): void {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" })
  const objectUrl = URL.createObjectURL(blob)
  const link = document.createElement("a")
  link.href = objectUrl
  link.download = filename
  document.body.appendChild(link)
  link.click()
  link.remove()
  URL.revokeObjectURL(objectUrl)
}
