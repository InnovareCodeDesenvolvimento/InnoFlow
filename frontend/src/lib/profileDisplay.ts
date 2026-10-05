/** Inicial do primeiro nome, em maiúscula (`?` quando não há nome). Pura, para ser testada sem DOM. */
export function nameInitial(name: string | null | undefined): string {
  const first = (name ?? "").trim().charAt(0)
  return first ? first.toLocaleUpperCase("pt-BR") : "?"
}

/** Primeiro nome para saudação/cabeçalho (`""` quando não há nome). */
export function firstName(name: string | null | undefined): string {
  return (name ?? "").trim().split(/\s+/)[0] ?? ""
}
