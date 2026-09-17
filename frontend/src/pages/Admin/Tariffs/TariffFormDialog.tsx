import { useEffect } from "react"
import { useForm } from "react-hook-form"
import { zodResolver } from "@hookform/resolvers/zod"
import { toast } from "sonner"
import { Check, Plus, Wallet, X } from "lucide-react"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/Dialog"
import { Input } from "@/components/ui/Input"
import { Select } from "@/components/ui/Select"
import { Button } from "@/components/ui/Button"
import { useAuthStore } from "@/store/authStore"
import { useCreateTariff, useUpdateTariff } from "@/hooks/useTariffs"
import { getApiErrorMessage } from "@/services/api"
import { centsToReais, reaisToCents } from "@/lib/utils"
import { tariffFormSchema, type TariffFormInput, type TariffFormValues } from "@/schemas/tariff.schema"
import { TARIFF_MODELS, type Tariff } from "@/types/api"

const MODEL_LABELS: Record<(typeof TARIFF_MODELS)[number], string> = {
  PER_KWH: "Por kWh",
  PER_MINUTE: "Por minuto",
  PER_SESSION: "Por sessão (valor fechado)",
  HYBRID: "Híbrido (kWh + minuto)",
}
const MODEL_OPTIONS = TARIFF_MODELS.map((m) => ({ value: m, label: MODEL_LABELS[m] }))

/**
 * Valores em REAIS no formulário (mais natural para quem preenche);
 * convertidos para centavos só no submit — o contrato da API é centavos
 * inteiros para `sessionFeeCents`/`minChargeCents`/`idleFeePerMinute` (ver
 * schema.prisma, comentário do model Tariff).
 */
export function TariffFormDialog({
  open,
  onOpenChange,
  tariff,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  tariff?: Tariff | null
}) {
  const isEdit = Boolean(tariff)
  const user = useAuthStore((s) => s.user)
  const createTariff = useCreateTariff()
  const updateTariff = useUpdateTariff()

  const {
    register,
    handleSubmit,
    reset,
    setError,
    formState: { errors, isSubmitting },
  } = useForm<TariffFormInput, unknown, TariffFormValues>({
    resolver: zodResolver(tariffFormSchema),
    defaultValues: { currency: "BRL", idleFeePerMinuteReais: 0, idleGracePeriodSeconds: 0 },
  })

  useEffect(() => {
    if (!open) return
    if (tariff) {
      reset({
        name: tariff.name,
        model: tariff.model,
        pricePerKwh: tariff.pricePerKwh ? Number(tariff.pricePerKwh) : undefined,
        pricePerMinute: tariff.pricePerMinute ? Number(tariff.pricePerMinute) : undefined,
        sessionFeeReais: centsToReais(tariff.sessionFeeCents),
        minChargeReais: centsToReais(tariff.minChargeCents),
        idleFeePerMinuteReais: centsToReais(tariff.idleFeePerMinute) ?? 0,
        idleGracePeriodSeconds: tariff.idleGracePeriodSeconds,
        currency: tariff.currency,
        active: tariff.active,
      })
    } else {
      reset({ currency: "BRL", idleFeePerMinuteReais: 0, idleGracePeriodSeconds: 0 })
    }
  }, [open, tariff, reset])

  const onSubmit = async (values: TariffFormValues) => {
    const payload = {
      name: values.name,
      model: values.model,
      pricePerKwh: values.pricePerKwh,
      pricePerMinute: values.pricePerMinute,
      sessionFeeCents: reaisToCents(values.sessionFeeReais),
      minChargeCents: reaisToCents(values.minChargeReais),
      idleFeePerMinute: reaisToCents(values.idleFeePerMinuteReais) ?? 0,
      idleGracePeriodSeconds: values.idleGracePeriodSeconds,
      currency: values.currency,
      active: values.active,
    }

    try {
      if (isEdit && tariff) {
        await updateTariff.mutateAsync({ id: tariff.id, payload })
        toast.success("Tarifa atualizada.")
      } else {
        if (user?.role === "ADMIN" && !values.operatorId) {
          setError("operatorId", { message: "Informe o ID do operador dono desta tarifa." })
          return
        }
        await createTariff.mutateAsync({ ...payload, operatorId: values.operatorId })
        toast.success("Tarifa criada.")
      }
      onOpenChange(false)
    } catch (err) {
      toast.error(isEdit ? "Não foi possível atualizar." : "Não foi possível criar.", { description: getApiErrorMessage(err) })
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent widthClassName="sm:max-w-xl">
        <DialogHeader icon={Wallet}>
          <DialogTitle>{isEdit ? "Editar tarifa" : "Nova tarifa"}</DialogTitle>
          <DialogDescription>Preço cobrado do motorista pela recarga.</DialogDescription>
        </DialogHeader>

        <form className="space-y-4" onSubmit={handleSubmit(onSubmit)} noValidate>
          {!isEdit && user?.role === "ADMIN" && (
            <Input
              label="ID do operador (cuid)"
              hint="Não há seletor ainda — cole o id do operador dono desta tarifa."
              required
              error={errors.operatorId?.message}
              {...register("operatorId")}
            />
          )}

          <div className="grid grid-cols-2 gap-4">
            <Input label="Nome" required error={errors.name?.message} {...register("name")} />
            <Select label="Modelo" required options={MODEL_OPTIONS} error={errors.model?.message} {...register("model")} />
          </div>

          <div className="grid grid-cols-2 gap-4">
            <Input
              type="number"
              step="0.0001"
              min={0}
              label="Preço por kWh (R$)"
              error={errors.pricePerKwh?.message}
              {...register("pricePerKwh")}
            />
            <Input
              type="number"
              step="0.0001"
              min={0}
              label="Preço por minuto (R$)"
              error={errors.pricePerMinute?.message}
              {...register("pricePerMinute")}
            />
          </div>

          <div className="grid grid-cols-2 gap-4">
            <Input
              type="number"
              step="0.01"
              min={0}
              label="Taxa fixa por sessão (R$)"
              error={errors.sessionFeeReais?.message}
              {...register("sessionFeeReais")}
            />
            <Input
              type="number"
              step="0.01"
              min={0}
              label="Cobrança mínima (R$)"
              error={errors.minChargeReais?.message}
              {...register("minChargeReais")}
            />
          </div>

          <div className="grid grid-cols-2 gap-4">
            <Input
              type="number"
              step="0.01"
              min={0}
              label="Taxa de ociosidade (R$/min)"
              hint="Cobrada quando o carro fica plugado sem consumir, após a carga terminar."
              error={errors.idleFeePerMinuteReais?.message}
              {...register("idleFeePerMinuteReais")}
            />
            <Input
              type="number"
              min={0}
              label="Carência antes da ociosidade (s)"
              error={errors.idleGracePeriodSeconds?.message}
              {...register("idleGracePeriodSeconds")}
            />
          </div>

          <Input label="Moeda" maxLength={3} error={errors.currency?.message} {...register("currency")} />

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              <X className="h-4 w-4" aria-hidden="true" />
              Cancelar
            </Button>
            <Button type="submit" loading={isSubmitting}>
              {!isSubmitting && (isEdit ? <Check className="h-4 w-4" aria-hidden="true" /> : <Plus className="h-4 w-4" aria-hidden="true" />)}
              {isEdit ? "Salvar alterações" : "Criar tarifa"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
