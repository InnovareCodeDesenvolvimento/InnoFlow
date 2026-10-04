import { useMemo, useState } from "react"
import { useForm, useWatch } from "react-hook-form"
import { zodResolver } from "@hookform/resolvers/zod"
import { toast } from "sonner"
import { Check, Info, Link2, Plus, X } from "lucide-react"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/Dialog"
import { Input } from "@/components/ui/Input"
import { Select } from "@/components/ui/Select"
import { Button } from "@/components/ui/Button"
import { useChargePoints } from "@/hooks/useChargePoints"
import { useSites } from "@/hooks/useSites"
import { useTariffs } from "@/hooks/useTariffs"
import { useCreateTariffAssignment, useUpdateTariffAssignment } from "@/hooks/useTariffAssignments"
import { getApiErrorDetails, getApiErrorMessage } from "@/services/api"
import { SCOPE_HINTS, SCOPE_OPTION_LABELS, dateInputToEndIso, dateInputToStartIso, isInPast, isoToDateInput } from "@/lib/tariffAssignments"
import { buildCreatePayload, buildTargetOptions, describeAssignmentTarget, describeTariffPrice } from "@/lib/tariffAssignmentTargets"
import { useAuthStore } from "@/store/authStore"
import { tariffAssignmentFormSchema, type TariffAssignmentFormInput, type TariffAssignmentFormValues } from "@/schemas/tariffAssignment.schema"
import { TARIFF_ASSIGNMENT_SCOPES, type ChargePoint, type TariffAssignment, type TariffAssignmentScope } from "@/types/api"

const SCOPE_OPTIONS = TARIFF_ASSIGNMENT_SCOPES.map((s) => ({
  value: s,
  label: SCOPE_OPTION_LABELS[s],
}))

function initialValues({ assignment, chargePoint, fixedTariffId, defaultScope }: FormProps): TariffAssignmentFormInput {
  if (assignment) {
    return {
      tariffId: assignment.tariffId,
      scope: assignment.scope,
      targetId: assignment.connectorId ?? assignment.chargePointId ?? assignment.siteId ?? "",
      priority: assignment.priority,
      validFrom: isoToDateInput(assignment.validFrom),
      validTo: isoToDateInput(assignment.validTo),
    }
  }
  const scope = defaultScope ?? (chargePoint ? "CHARGE_POINT" : "SITE")
  return {
    tariffId: fixedTariffId ?? "",
    scope,
    targetId: chargePoint && scope === "CHARGE_POINT" ? chargePoint.id : "",
    priority: 0,
    validFrom: "",
    validTo: "",
  }
}

type FormProps = {
  assignment?: TariffAssignment | null
  chargePoint?: ChargePoint
  fixedTariffId?: string
  defaultScope?: TariffAssignmentScope
}

/**
 * Criar / editar um vínculo de tarifa (`POST` / `PATCH /api/admin/tariff-assignments`).
 *  - Criar: escolhe tarifa, ONDE vale (escopo) e o alvo numa lista. Só existe um campo de alvo na tela — o campo certo do corpo
 *    é preenchido por `buildCreatePayload`, então a combinação que o servidor recusa (400) nem pode ser montada.
 *  - Editar: o servidor só aceita mudar tarifa, prioridade e vigência (escopo e alvo são imutáveis — outro alvo é outro vínculo),
 *    então escopo e alvo aparecem como texto.
 *  - `chargePoint`: contexto de um carregador (tela "Tarifas do carregador") — as listas de alvo ficam restritas a ele.
 *  - Multi-tenant: as listas de tarifa e de alvo são filtradas pelo MESMO operador (o da tarifa escolhida / do carregador). ADMIN manda
 *    esse `operatorId` no corpo; OPERATOR não precisa (o servidor usa o do token).
 */
export function TariffAssignmentFormDialog({ open, onOpenChange, ...formProps }: FormProps & { open: boolean; onOpenChange: (open: boolean) => void }) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent widthClassName="sm:max-w-xl">
        {/* O corpo só existe com o diálogo aberto: estado do formulário e erro do servidor nascem limpos a cada abertura, sem efeito de "reset". */}
        <AssignmentFormBody {...formProps} onClose={() => onOpenChange(false)} />
      </DialogContent>
    </Dialog>
  )
}

function AssignmentFormBody({ assignment, chargePoint, fixedTariffId, defaultScope, onClose }: FormProps & { onClose: () => void }) {
  const isEdit = Boolean(assignment)
  const role = useAuthStore((s) => s.user?.role)
  const tariffsQuery = useTariffs({ page: 1, pageSize: 100 })
  const sitesQuery = useSites({ page: 1, pageSize: 100 })
  const chargePointsQuery = useChargePoints({ page: 1, pageSize: 100 })
  const createAssignment = useCreateTariffAssignment()
  const updateAssignment = useUpdateTariffAssignment()
  const [serverError, setServerError] = useState<string[] | null>(null)

  const {
    register,
    handleSubmit,
    setValue,
    setError,
    control,
    formState: { errors, isSubmitting },
  } = useForm<TariffAssignmentFormInput, unknown, TariffAssignmentFormValues>({
    resolver: zodResolver(tariffAssignmentFormSchema),
    defaultValues: initialValues({
      assignment,
      chargePoint,
      fixedTariffId,
      defaultScope,
    }),
  })

  const scope = useWatch({ control, name: "scope" })
  const tariffId = useWatch({ control, name: "tariffId" })

  const tariffs = useMemo(() => tariffsQuery.data?.items ?? [], [tariffsQuery.data])
  const selectedTariff = tariffs.find((t) => t.id === tariffId)
  /** Operador dono do vínculo: o do carregador / do vínculo em edição / o da tarifa escolhida (ADMIN atravessa operadores). */
  const operatorId = assignment?.operatorId ?? chargePoint?.operatorId ?? selectedTariff?.operatorId

  // Com carregador ou vínculo em mãos o operador já está decidido: só as tarifas dele. Sem isso (ADMIN na tela de tarifas) a tarifa
  // escolhida é que decide o operador. Tarifa desativada não é oferecida para vínculo novo, mas continua aparecendo se já é a do vínculo.
  const ownerOperatorId = assignment?.operatorId ?? chargePoint?.operatorId
  const tariffOptions = tariffs
    .filter((t) => (!ownerOperatorId || t.operatorId === ownerOperatorId) && (t.active || t.id === assignment?.tariffId || t.id === fixedTariffId))
    .map((t) => ({
      value: t.id,
      label: `${t.name} — ${describeTariffPrice(t)}${t.active ? "" : " (desativada)"}`,
    }))

  const lookup = useMemo(
    () => ({
      sites: sitesQuery.data?.items ?? [],
      chargePoints: chargePointsQuery.data?.items ?? [],
    }),
    [sitesQuery.data, chargePointsQuery.data],
  )
  const targetOptions = buildTargetOptions({
    scope,
    operatorId,
    lookup,
    onlyChargePoint: chargePoint,
  })
  const loadingLists = tariffsQuery.isLoading || sitesQuery.isLoading || chargePointsQuery.isLoading
  const listsFailed = tariffsQuery.isError || sitesQuery.isError || chargePointsQuery.isError

  const onSubmit = async (values: TariffAssignmentFormValues) => {
    setServerError(null)
    const endIso = dateInputToEndIso(values.validTo)
    if (endIso && isInPast(endIso)) {
      setError("validTo", {
        message: "Essa data já passou. Para encerrar um vínculo agora, use Remover.",
      })
      return
    }

    try {
      if (isEdit && assignment) {
        await updateAssignment.mutateAsync({
          id: assignment.id,
          payload: {
            tariffId: values.tariffId,
            priority: values.priority,
            // Só manda a vigência que o usuário mexeu (reenviar a data intacta trocaria 12:00 por 00:00 sem motivo).
            ...(values.validFrom !== isoToDateInput(assignment.validFrom) && values.validFrom ? { validFrom: dateInputToStartIso(values.validFrom) } : {}),
            // Campo apagado na edição = "sem data final": o PATCH aceita `null` para isso.
            ...(values.validTo !== isoToDateInput(assignment.validTo) ? { validTo: endIso ?? null } : {}),
          },
        })
        toast.success("Vínculo atualizado.")
      } else {
        await createAssignment.mutateAsync(buildCreatePayload(values, role === "ADMIN" ? operatorId : undefined))
        toast.success("Tarifa vinculada.")
      }
      onClose()
    } catch (err) {
      const details = getApiErrorDetails(err)
      setServerError(
        details.length > 0 ? details : [getApiErrorMessage(err, isEdit ? "Não foi possível atualizar o vínculo." : "Não foi possível vincular a tarifa.")],
      )
    }
  }

  const target = assignment ? describeAssignmentTarget(assignment, lookup) : null

  return (
    <>
      <DialogHeader icon={Link2}>
        <DialogTitle>{isEdit ? "Editar vínculo de tarifa" : "Vincular tarifa"}</DialogTitle>
        <DialogDescription>
          {chargePoint ? `Escolha qual tarifa vale em ${chargePoint.ocppIdentity}, ou em parte dele.` : "Escolha qual tarifa vale e onde."}
        </DialogDescription>
      </DialogHeader>

      {listsFailed && (
        <p role="alert" className="mb-4 rounded-lg bg-danger-50 px-3 py-2 text-sm font-medium text-danger-700">
          Não foi possível carregar as listas de tarifas e locais. Feche e tente de novo.
        </p>
      )}

      <form className="space-y-4" onSubmit={handleSubmit(onSubmit)} noValidate>
        <Select
          label="Tarifa"
          required
          disabled={Boolean(fixedTariffId) || loadingLists}
          placeholder={loadingLists ? "Carregando..." : "Selecione a tarifa"}
          options={tariffOptions}
          error={errors.tariffId?.message}
          {...register("tariffId", {
            onChange: (e) => {
              // Outro operador = outra lista de locais/carregadores/tomadas: o alvo escolhido deixa de valer.
              const next = tariffs.find((t) => t.id === e.target.value)
              if (!chargePoint && !assignment && next && next.operatorId !== operatorId) setValue("targetId", "")
            },
          })}
        />
        {!isEdit && !chargePoint && role === "ADMIN" && (
          <p className="-mt-2 text-xs text-ink-softer">A tarifa define o operador: só aparecem locais e carregadores do mesmo operador dela.</p>
        )}

        {isEdit && target ? (
          <div className="rounded-lg bg-muted/50 px-3.5 py-3 text-sm">
            <p className="text-xs font-bold uppercase tracking-wide text-ink-softer">Onde vale</p>
            <p className="mt-0.5 font-semibold text-ink">
              {target.kind}: <span className="font-medium">{target.name}</span>
            </p>
            <p className="mt-1 text-xs text-ink-softer">Para vincular a outro local, carregador ou tomada, crie um vínculo novo.</p>
          </div>
        ) : (
          <>
            <Select
              label="Onde vale"
              required
              options={SCOPE_OPTIONS}
              error={errors.scope?.message}
              {...register("scope", {
                onChange: (e) => setValue("targetId", chargePoint && e.target.value === "CHARGE_POINT" ? chargePoint.id : ""),
              })}
            />
            <p className="-mt-2 text-xs text-ink-softer" data-testid="scope-hint">
              {SCOPE_HINTS[scope]}
            </p>
            {scope !== "OPERATOR" && (
              <Select
                label={scope === "CONNECTOR" ? "Tomada" : scope === "CHARGE_POINT" ? "Carregador" : "Local"}
                required
                disabled={loadingLists}
                placeholder={loadingLists ? "Carregando..." : "Selecione"}
                options={targetOptions}
                error={errors.targetId?.message}
                {...register("targetId")}
              />
            )}
            {scope !== "OPERATOR" && !loadingLists && targetOptions.length === 0 && (
              <p className="-mt-2 text-xs text-warning-700">Nenhum item disponível para este operador. Cadastre antes o local, o carregador ou a tomada.</p>
            )}
          </>
        )}

        <Input
          type="number"
          min={0}
          step={1}
          label="Prioridade"
          hint="Quando mais de uma tarifa vale para a mesma tomada, vence a de maior prioridade (0 é o normal). Se empatar, vence a mais específica (tomada, carregador, local, operador) e depois a mais recente."
          error={errors.priority?.message}
          {...register("priority")}
        />

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Input
            type="date"
            label="Vale a partir de (opcional)"
            hint="Em branco: vale desde já."
            error={errors.validFrom?.message}
            {...register("validFrom")}
          />
          <Input
            type="date"
            label="Vale até (opcional)"
            hint="Em branco: sem data para acabar. Inclui o dia inteiro."
            error={errors.validTo?.message}
            {...register("validTo")}
          />
        </div>

        {serverError && (
          <div
            role="alert"
            className="flex items-start gap-2 rounded-lg bg-danger-50 px-3 py-2 text-sm font-medium text-danger-700"
            data-testid="assignment-server-error"
          >
            <Info className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
            <div className="min-w-0">
              {serverError.map((m) => (
                <p key={m}>{m}</p>
              ))}
            </div>
          </div>
        )}

        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose}>
            <X className="h-4 w-4" aria-hidden="true" />
            Cancelar
          </Button>
          <Button type="submit" loading={isSubmitting} disabled={listsFailed}>
            {!isSubmitting && (isEdit ? <Check className="h-4 w-4" aria-hidden="true" /> : <Plus className="h-4 w-4" aria-hidden="true" />)}
            {isEdit ? "Salvar alterações" : "Vincular tarifa"}
          </Button>
        </DialogFooter>
      </form>
    </>
  )
}
