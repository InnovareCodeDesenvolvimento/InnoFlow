import { Route } from "lucide-react"
import { MascotFace } from "@/components/brand/Mascot"
import { ChangePasswordForm } from "@/components/perfil/ChangePasswordForm"
import { ProfileAvatar } from "@/components/perfil/ProfileAvatar"
import { NotificationsSection } from "@/components/perfil/NotificationsSection"
import { ProfileDataForm } from "@/components/perfil/ProfileDataForm"
import { PrivacySection } from "@/components/perfil/PrivacySection"
import { ProfileSection } from "@/components/perfil/ProfileSection"
import { useTour } from "@/components/onboarding/tourContext"
import { AppBand } from "@/components/pwa/AppBand"
import { Button } from "@/components/ui/Button"
import { Card } from "@/components/ui/Card"
import { ErrorState } from "@/components/ui/ErrorState"
import { Skeleton } from "@/components/ui/Skeleton"
import { useMeProfile } from "@/hooks/useMeProfile"
import { PROFILE_LOAD_FALLBACK_MESSAGE, profileLoadError } from "@/lib/profileErrors"
import { useAuthStore } from "@/store/authStore"

/**
 * Esqueleto com a FORMA do card real (medida no navegador, ver `e2e-visual/criterios-perfil.visual.ts`): cabeçalho (selo + título de 24 px + N linhas de descrição de 20 px),
 * campos nas alturas reais de `Input` (rótulo + campo [+ dica]; abaixo de `sm` o campo tem 46 px, de `sm` em diante 42 px), uma linha opcional de 44 px (o "Mostrar senhas") e o botão
 * de 48 px. Assim a página não pula quando o perfil chega. As alturas são as do usuário SEM CPF salvo (o caso comum); com CPF salvo o card real é ~12 px menor.
 */
function SectionSkeleton({ descriptionLines, fields, checkboxRow = false }: { descriptionLines: number; fields: Array<"plain" | "hint">; checkboxRow?: boolean }) {
  return (
    <Card aria-hidden="true">
      <div className="flex items-start gap-3 p-5 pb-3 sm:p-6 sm:pb-3">
        <Skeleton className="h-11 w-11 shrink-0 rounded-card" />
        <div className="flex-1 space-y-0.5">
          <Skeleton className="h-6 w-36" />
          {Array.from({ length: descriptionLines }, (_, i) => (
            <Skeleton key={i} className={i === descriptionLines - 1 ? "h-5 w-3/4" : "h-5 w-full"} />
          ))}
        </div>
      </div>
      <div className="space-y-4 p-5 pt-0 sm:p-6 sm:pt-0">
        {fields.map((kind, i) => (
          <Skeleton key={i} className={kind === "hint" ? "h-[5.875rem] rounded-control sm:h-[5.625rem]" : "h-[4.5rem] rounded-control sm:h-[4.25rem]"} />
        ))}
        {checkboxRow && <Skeleton className="h-11 w-40 rounded-control" />}
        <Skeleton className="h-12 rounded-control" />
      </div>
    </Card>
  )
}

/**
 * `/app/perfil` - o motorista vê e corrige os próprios dados e troca a senha. Acesso pelo cabeçalho do app (avatar ao lado do "Sair"): a barra inferior tem 5 destinos
 * e não ganha um sexto. A faixa escura mostra quem é (nome/e-mail do `authStore`, já disponíveis - sem esperar a rede); o miolo claro é uma PILHA DE SEÇÕES
 * (`ProfileSection`): uma nova seção é um novo item da pilha, sem mexer nas existentes. Só o que existe aparece - nada de seção "em breve".
 */
export function Perfil() {
  const user = useAuthStore((s) => s.user)
  const tour = useTour()
  const { data: profile, isLoading, isError, error, refetch } = useMeProfile()
  // Resposta vazia (200 sem corpo útil) também é falha de carregamento: sem perfil não há o que editar.
  const failed = isError || (!isLoading && !profile)

  return (
    <div>
      <AppBand back={{ to: "/app", label: "Início" }} className="pb-7">
        <div className="flex items-center gap-3.5">
          <ProfileAvatar name={profile?.name ?? user?.name} />
          <div className="min-w-0 flex-1">
            <h1 className="text-xl font-black tracking-tight text-ink">Meu perfil</h1>
            <p className="truncate text-sm font-semibold text-white">{profile?.name ?? user?.name}</p>
            <p className="truncate text-xs text-ink-softer">{profile?.email ?? user?.email}</p>
          </div>
        </div>
      </AppBand>

      <div className="mx-auto max-w-md space-y-5 px-4 py-5">
        {isLoading && (
          <div className="space-y-5" data-testid="perfil-carregando">
            <SectionSkeleton descriptionLines={1} fields={["plain", "hint", "hint", "hint"]} />
            <SectionSkeleton descriptionLines={2} fields={["plain", "hint", "plain"]} checkboxRow />
          </div>
        )}

        {failed && (
          <ErrorState
            tone="page"
            art={<MascotFace size={64} />}
            message={isError ? profileLoadError(error) : PROFILE_LOAD_FALLBACK_MESSAGE}
            onRetry={() => refetch()}
          />
        )}

        {!isLoading && !failed && profile && (
          <>
            <ProfileDataForm profile={profile} />
            <ChangePasswordForm hasPassword={profile.hasPassword} />
            <NotificationsSection />
            <PrivacySection profile={profile} />
            {tour.available && (
              <ProfileSection icon={Route} title="Ajuda" description="Reveja o passo a passo do aplicativo, com o mascote da InnoFlow.">
                <Button type="button" variant="outline" size="touch" className="h-11 sm:h-11" onClick={tour.restart}>
                  Rever tour
                </Button>
              </ProfileSection>
            )}
            {/* Próximas seções entram aqui (uma `ProfileSection` por assunto), só quando a funcionalidade existir. */}
          </>
        )}
      </div>
    </div>
  )
}
