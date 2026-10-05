/**
 * Regras PURAS do perfil do motorista (L1.2) — sem banco, sem HTTP. Testáveis direto.
 */

/** Campos do perfil que o motorista pode alterar neste lote (e-mail NÃO — troca de e-mail exige verificação no endereço novo, F7). */
export const CAMPOS_EDITAVEIS_PERFIL = ['name', 'phone', 'cpf'] as const
export type CampoEditavelPerfil = (typeof CAMPOS_EDITAVEIS_PERFIL)[number]

/**
 * CPF mascarado para a API: `***.456.789-**` (só os dígitos 4 a 9 ficam visíveis). O CPF inteiro só sai na exportação LGPD, que é do próprio titular.
 * Valor ausente ou fora do formato (11 dígitos) vira `null` — nunca devolve um pedaço de lixo.
 */
export function mascararCpf(cpf: string | null | undefined): string | null {
  if (!cpf || !/^\d{11}$/.test(cpf)) return null
  return `***.${cpf.slice(3, 6)}.${cpf.slice(6, 9)}-**`
}

export interface PerfilArmazenado {
  name: string
  phone: string | null
  cpf: string | null
}

export interface MudancaDePerfil {
  /** Só os campos que REALMENTE mudam (valor novo diferente do atual) — vai para o `update`. */
  dados: Partial<PerfilArmazenado>
  /** Nomes dos campos alterados — é só isto que vai para a auditoria (os valores são dado pessoal). */
  camposAlterados: CampoEditavelPerfil[]
}

/** Compara o pedido (campo ausente = não mexer; `null` = apagar) com o que está gravado. */
export function calcularMudancaDePerfil(atual: PerfilArmazenado, pedido: Partial<PerfilArmazenado>): MudancaDePerfil {
  const dados: Partial<PerfilArmazenado> = {}
  const camposAlterados: CampoEditavelPerfil[] = []
  for (const campo of CAMPOS_EDITAVEIS_PERFIL) {
    const novo = pedido[campo]
    if (novo === undefined) continue
    if (novo === atual[campo]) continue
    ;(dados as Record<string, unknown>)[campo] = novo
    camposAlterados.push(campo)
  }
  return { dados, camposAlterados }
}
