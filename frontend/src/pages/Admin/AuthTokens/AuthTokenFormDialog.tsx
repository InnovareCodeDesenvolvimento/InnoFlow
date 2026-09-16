import { useEffect } from "react"
import { useForm } from "react-hook-form"
import { zodResolver } from "@hookform/resolvers/zod"
import { toast } from "sonner"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/Dialog"
import { Input } from "@/components/ui/Input"
import { Select } from "@/components/ui/Select"
import { Button } from "@/components/ui/Button"
import { useCreateAuthToken, useUpdateAuthToken } from "@/hooks/useAuthTokens"
import { getApiErrorMessage } from "@/services/api"
import { authTokenFormSchema, type AuthTokenFormValues } from "@/schemas/authToken.schema"
import { AUTH_TOKEN_STATUSES, AUTH_TOKEN_TYPES, type AuthToken } from "@/types/api"

const TYPE_LABELS: Record<(typeof AUTH_TOKEN_TYPES)[number], string> = { RFID: "Cartão RFID", VIRTUAL: "Virtual", APP: "App" }
const STATUS_LABELS: Record<(typeof AUTH_TOKEN_STATUSES)[number], string> = {
  ACCEPTED: "Aceito",
  BLOCKED: "Bloqueado",
  EXPIRED: "Expirado",
  INVALID: "Inválido",
}
const TYPE_OPTIONS = AUTH_TOKEN_TYPES.map((t) => ({ value: t, label: TYPE_LABELS[t] }))
const STATUS_OPTIONS = AUTH_TOKEN_STATUSES.map((s) => ({ value: s, label: STATUS_LABELS[s] }))

export function AuthTokenFormDialog({
  open,
  onOpenChange,
  authToken,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  authToken?: AuthToken | null
}) {
  const isEdit = Boolean(authToken)
  const createToken = useCreateAuthToken()
  const updateToken = useUpdateAuthToken()

  const {
    register,
    handleSubmit,
    reset,
    formState: { errors, isSubmitting },
  } = useForm<AuthTokenFormValues>({ resolver: zodResolver(authTokenFormSchema) })

  useEffect(() => {
    if (!open) return
    if (authToken) {
      reset({ idTag: authToken.idTag, type: authToken.type, status: authToken.status })
    } else {
      reset({ idTag: "", type: "RFID" })
    }
  }, [open, authToken, reset])

  const onSubmit = async (values: AuthTokenFormValues) => {
    try {
      if (isEdit && authToken) {
        await updateToken.mutateAsync({ id: authToken.id, payload: { status: values.status } })
        toast.success("Token atualizado.")
      } else {
        await createToken.mutateAsync({ idTag: values.idTag, type: values.type })
        toast.success("Token criado.")
      }
      onOpenChange(false)
    } catch (err) {
      toast.error(isEdit ? "Não foi possível atualizar." : "Não foi possível criar.", { description: getApiErrorMessage(err) })
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent widthClassName="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>{isEdit ? "Editar token" : "Novo token de autenticação"}</DialogTitle>
          <DialogDescription>Identidade de rede (RFID/app) — não pertence a um operador específico.</DialogDescription>
        </DialogHeader>

        <form className="space-y-4" onSubmit={handleSubmit(onSubmit)} noValidate>
          <Input
            label="idTag"
            hint="Máximo de 20 caracteres (limite do OCPP 1.6)."
            required
            disabled={isEdit}
            error={errors.idTag?.message}
            {...register("idTag")}
          />
          <Select label="Tipo" required disabled={isEdit} options={TYPE_OPTIONS} error={errors.type?.message} {...register("type")} />
          {isEdit && <Select label="Status" options={STATUS_OPTIONS} error={errors.status?.message} {...register("status")} />}

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancelar
            </Button>
            <Button type="submit" loading={isSubmitting}>
              {isEdit ? "Salvar alterações" : "Criar token"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
