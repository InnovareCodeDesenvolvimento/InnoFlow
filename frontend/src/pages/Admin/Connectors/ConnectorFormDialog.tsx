import { useEffect } from "react"
import { useForm } from "react-hook-form"
import { zodResolver } from "@hookform/resolvers/zod"
import { toast } from "sonner"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/Dialog"
import { Input } from "@/components/ui/Input"
import { Select } from "@/components/ui/Select"
import { Button } from "@/components/ui/Button"
import { useChargePoints } from "@/hooks/useChargePoints"
import { useCreateConnector, useUpdateConnector } from "@/hooks/useConnectors"
import { getApiErrorMessage } from "@/services/api"
import { CONNECTOR_STATUS_LABELS, CONNECTOR_TYPE_LABELS } from "@/lib/utils"
import { connectorFormSchema, type ConnectorFormInput, type ConnectorFormValues } from "@/schemas/connector.schema"
import { CONNECTOR_STATUSES, CONNECTOR_TYPES, type Connector } from "@/types/api"

const TYPE_OPTIONS = CONNECTOR_TYPES.map((t) => ({ value: t, label: CONNECTOR_TYPE_LABELS[t] }))
const STATUS_OPTIONS = CONNECTOR_STATUSES.map((s) => ({ value: s, label: CONNECTOR_STATUS_LABELS[s] }))

export function ConnectorFormDialog({
  open,
  onOpenChange,
  connector,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  connector?: Connector | null
}) {
  const isEdit = Boolean(connector)
  const { data: chargePointsData, isLoading: loadingCps } = useChargePoints({ page: 1, pageSize: 100 })
  const createConnector = useCreateConnector()
  const updateConnector = useUpdateConnector()

  const {
    register,
    handleSubmit,
    reset,
    formState: { errors, isSubmitting },
  } = useForm<ConnectorFormInput, unknown, ConnectorFormValues>({ resolver: zodResolver(connectorFormSchema) })

  useEffect(() => {
    if (!open) return
    if (connector) {
      reset({
        chargePointId: connector.chargePointId,
        connectorId: connector.connectorId,
        type: connector.type,
        maxPowerKw: connector.maxPowerKw ? Number(connector.maxPowerKw) : undefined,
        status: connector.status,
      })
    } else {
      reset({ chargePointId: "", connectorId: 1 })
    }
  }, [open, connector, reset])

  const onSubmit = async (values: ConnectorFormValues) => {
    try {
      if (isEdit && connector) {
        await updateConnector.mutateAsync({
          id: connector.id,
          payload: { type: values.type, maxPowerKw: values.maxPowerKw, status: values.status },
        })
        toast.success("Conector atualizado.")
      } else {
        await createConnector.mutateAsync({
          chargePointId: values.chargePointId,
          connectorId: values.connectorId,
          type: values.type,
          maxPowerKw: values.maxPowerKw,
        })
        toast.success("Conector criado.")
      }
      onOpenChange(false)
    } catch (err) {
      toast.error(isEdit ? "Não foi possível atualizar." : "Não foi possível criar.", { description: getApiErrorMessage(err) })
    }
  }

  const cpOptions = (chargePointsData?.items ?? []).map((cp) => ({
    value: cp.id,
    label: `${cp.ocppIdentity}${cp.site?.name ? ` — ${cp.site.name}` : ""}`,
  }))

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent widthClassName="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{isEdit ? "Editar conector" : "Novo conector"}</DialogTitle>
          <DialogDescription>Tomada individual de um ponto de recarga.</DialogDescription>
        </DialogHeader>

        <form className="space-y-4" onSubmit={handleSubmit(onSubmit)} noValidate>
          <Select
            label="Ponto de recarga"
            required
            disabled={isEdit || loadingCps}
            placeholder={loadingCps ? "Carregando..." : "Selecione o ponto de recarga"}
            options={cpOptions}
            error={errors.chargePointId?.message}
            {...register("chargePointId")}
          />

          <div className="grid grid-cols-2 gap-4">
            <Input
              type="number"
              min={1}
              label="Número do conector"
              hint="1, 2, 3... (0 é reservado ao ponto de recarga)."
              required
              disabled={isEdit}
              error={errors.connectorId?.message}
              {...register("connectorId")}
            />
            <Select label="Tipo" required options={TYPE_OPTIONS} error={errors.type?.message} {...register("type")} />
          </div>

          <div className="grid grid-cols-2 gap-4">
            <Input
              type="number"
              step="any"
              min={0}
              label="Potência máxima (kW)"
              error={errors.maxPowerKw?.message}
              {...register("maxPowerKw")}
            />
            {isEdit && (
              <Select label="Status" options={STATUS_OPTIONS} error={errors.status?.message} {...register("status")} />
            )}
          </div>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancelar
            </Button>
            <Button type="submit" loading={isSubmitting}>
              {isEdit ? "Salvar alterações" : "Criar conector"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
