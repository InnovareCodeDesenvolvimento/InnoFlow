import { useState } from "react"
import { Link } from "react-router-dom"
import { Check, ChevronRight, Route } from "lucide-react"
import { MascotFace } from "@/components/brand/Mascot"
import { Button } from "@/components/ui/Button"
import { buttonVariants } from "@/components/ui/buttonVariants"
import { Card, CardTitle } from "@/components/ui/Card"
import { cn } from "@/lib/utils"
import { CHECKLIST_UI } from "./checklistScript"
import { dismissChecklist, isChecklistDismissed, isOnboardingOff } from "./onboardingStorage"
import { useAdminChecklist } from "./useAdminChecklist"
import { useTour } from "./tourContext"
import "./tour.css"

/**
 * Card "Primeiros passos" do Dashboard do ADMIN (padrão `onboarding-checklist-card` do InnoChat). Sem ruído: não aparece enquanto os dados carregam, quando está tudo feito, quando o
 * usuário o dispensou (por usuário, neste aparelho) nem com o interruptor do aparelho ligado (`ONBOARDING_OFF_KEY`: harness de regressão visual / quiosque).
 * O portão (`OnboardingChecklist`) é barato e NÃO consulta nada; só `ChecklistCard` — que dispara as 7 consultas — monta quando há chance de o card aparecer.
 */
export function OnboardingChecklist({ userId }: { userId: string | undefined }) {
  const [hidden, setHidden] = useState(() => !userId || isOnboardingOff() || isChecklistDismissed(userId))
  const [announce, setAnnounce] = useState("")
  if (!userId) return null
  if (hidden) return <p className="sr-only" role="status">{announce}</p>

  return (
    <ChecklistCard
      onDismiss={() => {
        dismissChecklist(userId)
        setAnnounce(CHECKLIST_UI.dismissed)
        setHidden(true)
      }}
    />
  )
}

function ChecklistCard({ onDismiss }: { onDismiss: () => void }) {
  const { loading, view } = useAdminChecklist()
  const tour = useTour()
  if (loading || view.complete) return null

  const nextKey = view.items.find((i) => i.state === "todo")?.key
  const percent = Math.round((view.doneCount / view.total) * 100)

  return (
    <Card role="region" className="ob-card" data-tour-checklist="" aria-labelledby="ob-title">
      <div>
        <div className="ob-head">
          <span className="ob-stage surface-dark" aria-hidden="true">
            <MascotFace size={56} className="rounded-full" />
          </span>
          <div className="min-w-0 flex-1">
            <CardTitle as="h2" id="ob-title" className="text-lg">
              {CHECKLIST_UI.title}
            </CardTitle>
            <p className="mt-1 text-sm text-ink-softer">{CHECKLIST_UI.intro}</p>
          </div>
        </div>

        <div className="mt-4 flex items-center gap-3">
          <div
            className="ob-progress flex-1"
            role="progressbar"
            aria-label={CHECKLIST_UI.title}
            aria-valuemin={0}
            aria-valuemax={view.total}
            aria-valuenow={view.doneCount}
            aria-valuetext={CHECKLIST_UI.progress(view.doneCount, view.total)}
          >
            <div style={{ width: `${percent}%` }} />
          </div>
          <span className="shrink-0 text-xs font-semibold tabular-nums text-ink-softer">{CHECKLIST_UI.progress(view.doneCount, view.total)}</span>
        </div>

        <ol className="ob-list">
          {view.items.map((item, i) => (
            <li key={item.key} className="ob-item">
              <span className="ob-bullet" aria-hidden="true" data-done={item.state === "done" ? "" : undefined}>
                {item.state === "done" ? <Check className="h-4 w-4" strokeWidth={3} /> : i + 1}
              </span>
              <div className="min-w-0 flex-1">
                <p className={cn("text-sm font-semibold", item.state === "done" ? "text-ink-softer line-through" : "text-ink")}>
                  {item.title}
                  {item.state === "done" ? <span className="sr-only">, {CHECKLIST_UI.done}</span> : null}
                </p>
                {item.state === "done" ? null : <p className="mt-0.5 text-xs text-ink-softer">{item.description}</p>}
              </div>
              {item.state === "done" ? null : (
                <Link
                  to={item.href}
                  aria-label={`${item.cta}: ${item.title}`}
                  className={cn(buttonVariants({ variant: item.key === nextKey ? "primary" : "outline", size: "sm" }), "h-11 shrink-0 px-3")}
                >
                  {item.cta}
                  <ChevronRight className="h-4 w-4" aria-hidden="true" />
                </Link>
              )}
            </li>
          ))}
        </ol>

        <div className="mt-3 flex flex-wrap items-center justify-end gap-1">
          {tour.available ? (
            <Button type="button" variant="ghost" className="h-11 px-3 text-xs" onClick={tour.restart}>
              <Route className="h-4 w-4" aria-hidden="true" />
              {CHECKLIST_UI.replayTour}
            </Button>
          ) : null}
          <Button type="button" variant="ghost" className="h-11 px-3 text-xs" onClick={onDismiss} aria-label={CHECKLIST_UI.dismissLabel}>
            {CHECKLIST_UI.dismiss}
          </Button>
        </div>
      </div>
    </Card>
  )
}
