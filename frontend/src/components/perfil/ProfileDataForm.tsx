import { useEffect, useRef, useState } from "react"
import { useForm } from "react-hook-form"
import { zodResolver } from "@hookform/resolvers/zod"
import { CheckCircle2, TriangleAlert, UserRound } from "lucide-react"
import { Alert } from "@/components/ui/Alert"
import { Button } from "@/components/ui/Button"
import { Input } from "@/components/ui/Input"
import { ProfileSection } from "@/components/perfil/ProfileSection"
import { useUpdateMeProfile } from "@/hooks/useMeProfile"
import { formatCpf } from "@/lib/cpf"
import { profileSaveError } from "@/lib/profileErrors"
import { buildProfilePatch, profileFormSchema, type ProfileFormValues } from "@/schemas/profile.schema"
import type { MeProfile } from "@/types/api"

export const PROFILE_SAVED_MESSAGE = "Dados salvos."

/**
 * Dados pessoais do motorista: nome, telefone e CPF editáveis; e-mail SOMENTE leitura (decisão do dono: trocar e-mail exige verificar o endereço novo e fica para
 * depois - o servidor recusa o campo). O CPF salvo nunca volta inteiro (`cpfMasked`): para trocar, "Alterar CPF" abre um campo vazio; sem CPF salvo o campo já vem aberto.
 * Só vai ao servidor o que mudou (`buildProfilePatch`). Erros por `code` (nunca o texto do backend): de campo (CPF já usado, 400 por campo) ficam no campo, com o foco
 * nele; de rede/5xx/429 ficam num aviso do formulário, com o foco nele.
 */
export function ProfileDataForm({ profile }: { profile: MeProfile }) {
  const update = useUpdateMeProfile()
  const [cpfOpen, setCpfOpen] = useState(profile.cpfMasked === null)
  const [saved, setSaved] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)
  const errorRef = useRef<HTMLDivElement>(null)
  // O aviso só existe no DOM depois do render que o mostra: o foco vai para ele aqui, não no `catch` (o `setFormError(null)` do início de cada envio o desmonta, então
  // repetir o MESMO erro também remonta e refoca).
  useEffect(() => {
    if (formError) errorRef.current?.focus()
  }, [formError])

  const {
    register,
    handleSubmit,
    reset,
    setError,
    setValue,
    formState: { errors, isDirty },
  } = useForm<ProfileFormValues>({
    resolver: zodResolver(profileFormSchema),
    defaultValues: { name: profile.name, phone: profile.phone ?? "", cpf: "" },
  })

  const onSubmit = async (values: ProfileFormValues) => {
    setSaved(false)
    setFormError(null)
    const patch = buildProfilePatch(values, { name: profile.name, phone: profile.phone })
    if (!patch) return
    try {
      const next = await update.mutateAsync(patch)
      reset({ name: next.name, phone: next.phone ?? "", cpf: "" })
      setCpfOpen(next.cpfMasked === null)
      setSaved(true)
    } catch (err) {
      const mapped = profileSaveError(err)
      const entries = Object.entries(mapped.fields ?? {}) as Array<["name" | "phone" | "cpf", string]>
      if (entries.length > 0) {
        // O campo do CPF só existe no DOM quando aberto: se o servidor reclamou dele, abre antes de pedir o foco.
        if (entries.some(([f]) => f === "cpf")) setCpfOpen(true)
        entries.forEach(([field, message], i) => setError(field, { message }, { shouldFocus: i === 0 }))
        return
      }
      setFormError(mapped.message)
    } finally {
      update.reset() // CPF/telefone não ficam guardados em `variables` (ver `useUpdateMeProfile`)
    }
  }

  return (
    <ProfileSection icon={UserRound} title="Dados pessoais" description="Mantenha seu cadastro em dia.">
      <form className="space-y-4" onSubmit={handleSubmit(onSubmit)} onChange={() => setSaved(false)} noValidate>
        <Input label="Nome" autoComplete="name" required error={errors.name?.message} {...register("name")} />

        <Input
          type="email"
          label="E-mail"
          value={profile.email}
          readOnly
          aria-readonly="true"
          autoComplete="email"
          hint="O e-mail não pode ser alterado por aqui."
          className="bg-muted text-ink-softer"
        />

        <Input
          type="tel"
          inputMode="tel"
          label="Telefone"
          autoComplete="tel"
          hint="Opcional. Ex.: (11) 91234-5678"
          error={errors.phone?.message}
          {...register("phone")}
        />

        {cpfOpen ? (
          <div className="space-y-2">
            <Input
              label="CPF"
              inputMode="numeric"
              autoComplete="off"
              placeholder="000.000.000-00"
              maxLength={14}
              hint={profile.cpfMasked ? `Cadastrado: ${profile.cpfMasked}. Preencha só para trocar.` : "Opcional. Depois de salvo, mostramos só parte dele."}
              error={errors.cpf?.message}
              {...register("cpf", { onChange: (e) => setValue("cpf", formatCpf(e.target.value), { shouldDirty: true }) })}
            />
            {profile.cpfMasked && (
              <Button
                type="button"
                variant="ghost"
                size="touch-sm"
                onClick={() => {
                  setValue("cpf", "", { shouldDirty: true })
                  setCpfOpen(false)
                }}
              >
                Manter o CPF atual
              </Button>
            )}
          </div>
        ) : (
          <div className="space-y-1.5">
            <p className="text-sm font-medium text-ink-soft">CPF</p>
            <div className="flex min-h-11 items-center justify-between gap-3">
              <p className="text-[16px] text-ink sm:text-sm" data-testid="cpf-masked">
                {profile.cpfMasked}
              </p>
              <Button type="button" variant="outline" size="touch-sm" onClick={() => setCpfOpen(true)}>
                Alterar CPF
              </Button>
            </div>
          </div>
        )}

        {formError && (
          <Alert ref={errorRef} tone="danger" icon={TriangleAlert} role="alert" tabIndex={-1} className="outline-none">
            {formError}
          </Alert>
        )}
        {saved && (
          <Alert tone="success" icon={CheckCircle2} role="status">
            {PROFILE_SAVED_MESSAGE}
          </Alert>
        )}

        <Button type="submit" size="lg" className="w-full" loading={update.isPending} disabled={!isDirty}>
          Salvar alterações
        </Button>
      </form>
    </ProfileSection>
  )
}
