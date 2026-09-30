import { useId, useState } from "react"
import { detectCardBrand } from "./cardBrand"
import type { CardFormInput } from "./sopClient"

export interface CardFormValues {
  cardNumber: string // dígitos puros
  holderName: string
  expiryMonth: string
  expiryYear: string
  cvv: string
}

const CURRENT_YEAR = new Date().getFullYear()

function onlyDigits(value: string): string {
  return value.replace(/\D/g, "")
}

function groupCardNumber(digits: string): string {
  return digits.replace(/(\d{4})(?=\d)/g, "$1 ")
}

/** `null` = válido. Roda no submit — sem PAN/CVV nunca saindo desta função, só o veredito. */
function validate(values: CardFormValues): Partial<Record<keyof CardFormValues, string>> {
  const errors: Partial<Record<keyof CardFormValues, string>> = {}

  if (values.cardNumber.length < 13 || values.cardNumber.length > 19) {
    errors.cardNumber = "Número de cartão inválido."
  } else if (!detectCardBrand(values.cardNumber)) {
    errors.cardNumber = "Não reconhecemos a bandeira deste cartão."
  }

  if (!values.holderName.trim()) {
    errors.holderName = "Informe o nome impresso no cartão."
  }

  const month = Number(values.expiryMonth)
  if (!values.expiryMonth || month < 1 || month > 12) {
    errors.expiryMonth = "Mês inválido."
  }

  const year = Number(values.expiryYear)
  if (!values.expiryYear || values.expiryYear.length !== 4 || year < CURRENT_YEAR || year > CURRENT_YEAR + 20) {
    errors.expiryYear = "Ano inválido."
  } else if (year === CURRENT_YEAR && month && month < new Date().getMonth() + 1) {
    errors.expiryYear = "Cartão vencido."
  }

  if (values.cvv.length < 3 || values.cvv.length > 4) {
    errors.cvv = "CVV inválido."
  }

  return errors
}

/**
 * Formulário MÍNIMO (número, validade, CVV, nome) — de propósito sem
 * `@/components/ui/Input` (evita puxar `class-variance-authority`/`cn` no
 * bundle isolado, ver `eslint.config.js`). Mesma paleta do app principal
 * (`pagamento-cartao.css`), estilo local simples.
 */
export function CardForm({
  onSubmit,
  submitting,
  formError,
}: {
  onSubmit: (values: CardFormInput) => void
  submitting: boolean
  formError: string | null
}) {
  const [values, setValues] = useState<CardFormValues>({ cardNumber: "", holderName: "", expiryMonth: "", expiryYear: "", cvv: "" })
  const [errors, setErrors] = useState<Partial<Record<keyof CardFormValues, string>>>({})
  const idPrefix = useId()

  function handleSubmit(event: React.FormEvent) {
    event.preventDefault()
    const validation = validate(values)
    setErrors(validation)
    if (Object.keys(validation).length > 0) return
    const brand = detectCardBrand(values.cardNumber)
    if (!brand) return // já coberto por validate(), guarda extra pro TS
    onSubmit({ cardNumber: values.cardNumber, holderName: values.holderName.trim(), expiryMonth: values.expiryMonth, expiryYear: values.expiryYear, cvv: values.cvv, brand })
  }

  return (
    <form onSubmit={handleSubmit} noValidate>
      {formError && (
        <div className="pc-alert pc-alert-danger" role="alert">
          {formError}
        </div>
      )}

      <div className="pc-field">
        <label htmlFor={`${idPrefix}-number`}>Número do cartão</label>
        <input
          id={`${idPrefix}-number`}
          inputMode="numeric"
          autoComplete="cc-number"
          maxLength={23} // 19 dígitos + 4 espaços de agrupamento
          value={groupCardNumber(values.cardNumber)}
          onChange={(e) => setValues((v) => ({ ...v, cardNumber: onlyDigits(e.target.value).slice(0, 19) }))}
          aria-invalid={!!errors.cardNumber}
          aria-describedby={errors.cardNumber ? `${idPrefix}-number-error` : undefined}
          placeholder="0000 0000 0000 0000"
          disabled={submitting}
        />
        {errors.cardNumber && (
          <p id={`${idPrefix}-number-error`} className="pc-field-error" role="alert">
            {errors.cardNumber}
          </p>
        )}
      </div>

      <div className="pc-field">
        <label htmlFor={`${idPrefix}-holder`}>Nome impresso no cartão</label>
        <input
          id={`${idPrefix}-holder`}
          autoComplete="cc-name"
          value={values.holderName}
          onChange={(e) => setValues((v) => ({ ...v, holderName: e.target.value.toUpperCase().slice(0, 60) }))}
          aria-invalid={!!errors.holderName}
          aria-describedby={errors.holderName ? `${idPrefix}-holder-error` : undefined}
          placeholder="COMO ESTÁ NO CARTÃO"
          disabled={submitting}
        />
        {errors.holderName && (
          <p id={`${idPrefix}-holder-error`} className="pc-field-error" role="alert">
            {errors.holderName}
          </p>
        )}
      </div>

      <div className="pc-row">
        <div className="pc-field">
          <label htmlFor={`${idPrefix}-month`}>Mês</label>
          <input
            id={`${idPrefix}-month`}
            inputMode="numeric"
            autoComplete="cc-exp-month"
            maxLength={2}
            value={values.expiryMonth}
            onChange={(e) => setValues((v) => ({ ...v, expiryMonth: onlyDigits(e.target.value).slice(0, 2) }))}
            aria-invalid={!!errors.expiryMonth}
            aria-describedby={errors.expiryMonth ? `${idPrefix}-month-error` : undefined}
            placeholder="MM"
            disabled={submitting}
          />
          {errors.expiryMonth && (
            <p id={`${idPrefix}-month-error`} className="pc-field-error" role="alert">
              {errors.expiryMonth}
            </p>
          )}
        </div>
        <div className="pc-field">
          <label htmlFor={`${idPrefix}-year`}>Ano</label>
          <input
            id={`${idPrefix}-year`}
            inputMode="numeric"
            autoComplete="cc-exp-year"
            maxLength={4}
            value={values.expiryYear}
            onChange={(e) => setValues((v) => ({ ...v, expiryYear: onlyDigits(e.target.value).slice(0, 4) }))}
            aria-invalid={!!errors.expiryYear}
            aria-describedby={errors.expiryYear ? `${idPrefix}-year-error` : undefined}
            placeholder="AAAA"
            disabled={submitting}
          />
          {errors.expiryYear && (
            <p id={`${idPrefix}-year-error`} className="pc-field-error" role="alert">
              {errors.expiryYear}
            </p>
          )}
        </div>
        <div className="pc-field">
          <label htmlFor={`${idPrefix}-cvv`}>CVV</label>
          <input
            id={`${idPrefix}-cvv`}
            inputMode="numeric"
            autoComplete="cc-csc"
            maxLength={4}
            value={values.cvv}
            onChange={(e) => setValues((v) => ({ ...v, cvv: onlyDigits(e.target.value).slice(0, 4) }))}
            aria-invalid={!!errors.cvv}
            aria-describedby={errors.cvv ? `${idPrefix}-cvv-error` : undefined}
            placeholder="123"
            disabled={submitting}
          />
          {errors.cvv && (
            <p id={`${idPrefix}-cvv-error`} className="pc-field-error" role="alert">
              {errors.cvv}
            </p>
          )}
        </div>
      </div>

      <button type="submit" className="pc-button" disabled={submitting}>
        {submitting && <span className="pc-spinner" aria-hidden="true" />}
        {submitting ? "Validando cartão…" : "Salvar cartão"}
      </button>

      <p className="pc-badge-secure">🔒 Conexão segura — seus dados não passam pelo InnoFlow</p>
    </form>
  )
}
