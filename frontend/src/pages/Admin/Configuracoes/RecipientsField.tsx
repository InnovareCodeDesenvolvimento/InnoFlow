import { Textarea } from "@/components/ui/Textarea"

/** Lista de destinatários num campo de texto (um por linha). O rascunho guarda o TEXTO; quem monta o PUT normaliza e tira repetidos. */
export function RecipientsField({
  label,
  value,
  onChange,
  error,
  hint,
  placeholder,
  testId,
  inputMode,
}: {
  label: string
  value: string
  onChange: (value: string) => void
  error?: string
  hint: string
  placeholder: string
  testId: string
  inputMode?: "email" | "tel" | "text"
}) {
  return (
    <Textarea
      label={label}
      rows={3}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      error={error}
      hint={hint}
      placeholder={placeholder}
      autoComplete="off"
      autoCapitalize="none"
      autoCorrect="off"
      spellCheck={false}
      inputMode={inputMode}
      data-testid={testId}
    />
  )
}
