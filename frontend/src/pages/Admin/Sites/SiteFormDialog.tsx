import { useEffect } from "react"
import { useForm } from "react-hook-form"
import { zodResolver } from "@hookform/resolvers/zod"
import { toast } from "sonner"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/Dialog"
import { Input } from "@/components/ui/Input"
import { Button } from "@/components/ui/Button"
import { useAuthStore } from "@/store/authStore"
import { useCreateSite, useUpdateSite } from "@/hooks/useSites"
import { getApiErrorMessage } from "@/services/api"
import { siteFormSchema, type SiteFormInput, type SiteFormValues } from "@/schemas/site.schema"
import type { Site } from "@/types/api"

/**
 * Criação/edição de site em modal. `operatorId` só aparece para ADMIN — e
 * como texto livre (cuid), não um seletor: não existe rota de listagem de
 * operadores nesta fase (nenhuma rota `/api/admin/operators` foi entregue
 * pela Vega). OPERATOR nem vê o campo — o backend usa o próprio operatorId
 * sempre (`resolveOperatorIdForWrite`).
 */
export function SiteFormDialog({
  open,
  onOpenChange,
  site,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  site?: Site | null
}) {
  const isEdit = Boolean(site)
  const user = useAuthStore((s) => s.user)
  const createSite = useCreateSite()
  const updateSite = useUpdateSite()

  const {
    register,
    handleSubmit,
    reset,
    setError,
    formState: { errors, isSubmitting },
  } = useForm<SiteFormInput, unknown, SiteFormValues>({
    resolver: zodResolver(siteFormSchema),
    defaultValues: { country: "BR", timezone: "America/Sao_Paulo" },
  })

  useEffect(() => {
    if (!open) return
    if (site) {
      reset({
        name: site.name,
        addressLine: site.addressLine,
        city: site.city,
        state: site.state,
        postalCode: site.postalCode,
        country: site.country,
        latitude: site.latitude,
        longitude: site.longitude,
        timezone: site.timezone,
        active: site.active,
      })
    } else {
      reset({ country: "BR", timezone: "America/Sao_Paulo" })
    }
  }, [open, site, reset])

  const onSubmit = async (values: SiteFormValues) => {
    try {
      if (isEdit && site) {
        await updateSite.mutateAsync({ id: site.id, payload: values })
        toast.success("Site atualizado.")
      } else {
        if (user?.role === "ADMIN" && !values.operatorId) {
          setError("operatorId", { message: "Informe o ID do operador dono deste site." })
          return
        }
        await createSite.mutateAsync(values)
        toast.success("Site criado.")
      }
      onOpenChange(false)
    } catch (err) {
      toast.error(isEdit ? "Não foi possível atualizar o site." : "Não foi possível criar o site.", {
        description: getApiErrorMessage(err),
      })
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent widthClassName="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{isEdit ? "Editar site" : "Novo site"}</DialogTitle>
          <DialogDescription>Endereço físico onde ficam os pontos de recarga.</DialogDescription>
        </DialogHeader>

        <form className="space-y-4" onSubmit={handleSubmit(onSubmit)} noValidate>
          {!isEdit && user?.role === "ADMIN" && (
            <Input
              label="ID do operador (cuid)"
              hint="Não há seletor ainda — cole o id do operador dono deste site."
              required
              error={errors.operatorId?.message}
              {...register("operatorId")}
            />
          )}

          <Input label="Nome" required error={errors.name?.message} {...register("name")} />
          <Input label="Endereço" required error={errors.addressLine?.message} {...register("addressLine")} />

          <div className="grid grid-cols-2 gap-4">
            <Input label="Cidade" required error={errors.city?.message} {...register("city")} />
            <Input label="UF" maxLength={2} required error={errors.state?.message} {...register("state")} />
          </div>

          <div className="grid grid-cols-2 gap-4">
            <Input label="CEP" required error={errors.postalCode?.message} {...register("postalCode")} />
            <Input label="País" maxLength={2} error={errors.country?.message} {...register("country")} />
          </div>

          <div className="grid grid-cols-2 gap-4">
            <Input
              type="number"
              step="any"
              label="Latitude"
              required
              error={errors.latitude?.message}
              {...register("latitude")}
            />
            <Input
              type="number"
              step="any"
              label="Longitude"
              required
              error={errors.longitude?.message}
              {...register("longitude")}
            />
          </div>

          <Input label="Fuso horário" hint="Ex.: America/Sao_Paulo" error={errors.timezone?.message} {...register("timezone")} />

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancelar
            </Button>
            <Button type="submit" loading={isSubmitting}>
              {isEdit ? "Salvar alterações" : "Criar site"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
