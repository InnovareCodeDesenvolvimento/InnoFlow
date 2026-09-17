import { useEffect } from "react"
import { useForm } from "react-hook-form"
import { zodResolver } from "@hookform/resolvers/zod"
import { toast } from "sonner"
import { Check, Plus, X, Zap } from "lucide-react"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/Dialog"
import { Input } from "@/components/ui/Input"
import { Select } from "@/components/ui/Select"
import { Button } from "@/components/ui/Button"
import { useSites } from "@/hooks/useSites"
import { useCreateChargePoint, useUpdateChargePoint } from "@/hooks/useChargePoints"
import { getApiErrorMessage } from "@/services/api"
import { chargePointFormSchema, type ChargePointFormValues } from "@/schemas/chargePoint.schema"
import type { ChargePoint } from "@/types/api"

export function ChargePointFormDialog({
  open,
  onOpenChange,
  chargePoint,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  chargePoint?: ChargePoint | null
}) {
  const isEdit = Boolean(chargePoint)
  // pageSize alto: não há endpoint de busca por nome ainda, então trazemos
  // até 100 sites para o seletor — suficiente para o volume desta fase.
  const { data: sitesData, isLoading: loadingSites } = useSites({ page: 1, pageSize: 100 })
  const createChargePoint = useCreateChargePoint()
  const updateChargePoint = useUpdateChargePoint()

  const {
    register,
    handleSubmit,
    reset,
    formState: { errors, isSubmitting },
  } = useForm<ChargePointFormValues>({ resolver: zodResolver(chargePointFormSchema) })

  useEffect(() => {
    if (!open) return
    if (chargePoint) {
      reset({
        siteId: chargePoint.siteId,
        ocppIdentity: chargePoint.ocppIdentity,
        vendor: chargePoint.vendor ?? "",
        model: chargePoint.model ?? "",
        serialNumber: chargePoint.serialNumber ?? "",
        firmwareVersion: chargePoint.firmwareVersion ?? "",
        active: chargePoint.active,
      })
    } else {
      reset({ siteId: "", ocppIdentity: "" })
    }
  }, [open, chargePoint, reset])

  const onSubmit = async (values: ChargePointFormValues) => {
    try {
      if (isEdit && chargePoint) {
        await updateChargePoint.mutateAsync({
          id: chargePoint.id,
          payload: {
            vendor: values.vendor,
            model: values.model,
            serialNumber: values.serialNumber,
            firmwareVersion: values.firmwareVersion,
            active: values.active,
            ...(values.basicAuthSecret ? { basicAuthSecret: values.basicAuthSecret } : {}),
          },
        })
        toast.success("Ponto de recarga atualizado.")
      } else {
        if (!values.basicAuthSecret) {
          toast.error("Informe o segredo de autenticação (Basic Auth) do carregador.")
          return
        }
        await createChargePoint.mutateAsync({ ...values, basicAuthSecret: values.basicAuthSecret })
        toast.success("Ponto de recarga criado.")
      }
      onOpenChange(false)
    } catch (err) {
      toast.error(isEdit ? "Não foi possível atualizar." : "Não foi possível criar.", { description: getApiErrorMessage(err) })
    }
  }

  const siteOptions = (sitesData?.items ?? []).map((s) => ({ value: s.id, label: `${s.name} — ${s.city}/${s.state}` }))

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent widthClassName="sm:max-w-xl">
        <DialogHeader icon={Zap}>
          <DialogTitle>{isEdit ? "Editar ponto de recarga" : "Novo ponto de recarga"}</DialogTitle>
          <DialogDescription>Carregador físico que fala OCPP 1.6-J com o gateway.</DialogDescription>
        </DialogHeader>

        <form className="space-y-4" onSubmit={handleSubmit(onSubmit)} noValidate>
          <Select
            label="Site"
            required
            disabled={isEdit || loadingSites}
            placeholder={loadingSites ? "Carregando sites..." : "Selecione o site"}
            options={siteOptions}
            error={errors.siteId?.message}
            {...register("siteId")}
          />

          <Input
            label="Identidade OCPP"
            hint="ID usado pelo carregador para conectar no gateway."
            required
            disabled={isEdit}
            error={errors.ocppIdentity?.message}
            {...register("ocppIdentity")}
          />

          <div className="grid grid-cols-2 gap-4">
            <Input label="Fabricante" error={errors.vendor?.message} {...register("vendor")} />
            <Input label="Modelo" error={errors.model?.message} {...register("model")} />
          </div>

          <div className="grid grid-cols-2 gap-4">
            <Input label="Número de série" error={errors.serialNumber?.message} {...register("serialNumber")} />
            <Input label="Versão do firmware" error={errors.firmwareVersion?.message} {...register("firmwareVersion")} />
          </div>

          <Input
            type="password"
            label={isEdit ? "Novo segredo Basic Auth (opcional)" : "Segredo Basic Auth"}
            hint={isEdit ? "Deixe em branco para manter o segredo atual." : "Mínimo de 8 caracteres — usado pelo carregador para autenticar no gateway."}
            required={!isEdit}
            error={errors.basicAuthSecret?.message}
            {...register("basicAuthSecret")}
          />

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              <X className="h-4 w-4" aria-hidden="true" />
              Cancelar
            </Button>
            <Button type="submit" loading={isSubmitting}>
              {!isSubmitting && (isEdit ? <Check className="h-4 w-4" aria-hidden="true" /> : <Plus className="h-4 w-4" aria-hidden="true" />)}
              {isEdit ? "Salvar alterações" : "Criar ponto de recarga"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
