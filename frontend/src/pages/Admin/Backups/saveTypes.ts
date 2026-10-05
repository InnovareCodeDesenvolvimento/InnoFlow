/** O que cada cartão de configuração (Agendamento, Destino) recebe do formulário para montar o seu rodapé "Salvar". */
export interface CardSave {
  /** Quantas alterações o cartão tem (cada linha do resumo do diálogo é uma). */
  count: number
  /** Quantos campos do cartão estão inválidos. */
  errorCount: number
  /** Esta alteração pede a senha atual (step-up)? */
  needsPassword: boolean
  canSave: boolean
  canDiscard: boolean
  /** Está salvando (e o diálogo de senha NÃO está aberto: nele quem mostra o "carregando" é o diálogo). */
  loading: boolean
  onSave: () => void
  onDiscard: () => void
}
