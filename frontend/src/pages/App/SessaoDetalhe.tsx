import { Link, useLocation, useParams } from "react-router-dom"
import { AlertTriangle, CheckCircle2, Zap } from "lucide-react"
import { MascotFace } from "@/components/brand/Mascot"
import { AppBand } from "@/components/pwa/AppBand"
import { Badge } from "@/components/ui/Badge"
import { Card, CardContent } from "@/components/ui/Card"
import { ErrorState } from "@/components/ui/ErrorState"
import { Skeleton } from "@/components/ui/Skeleton"
import { InstallPromptCard } from "@/components/pwa/InstallPromptCard"
import { SessionPaymentMethodBadge } from "@/components/sessao/SessionPaymentMethodBadge"
import { SessionClosureNotice } from "@/components/sessao/SessionClosureNotice"
import { useMeSessionDetail } from "@/hooks/useMeSessions"
import { getApiErrorMessage } from "@/services/api"
import { DRIVER_CLOSURE_COPY } from "@/lib/sessionClosureCopy"
import { getDriverClosureNotice, isActiveSessionStatus } from "@/lib/sessionClosure"
import {
  CHARGING_SESSION_STATUS_LABELS,
  SESSION_CARD_CAPTURE_STATUS_LABELS,
  formatCents,
  formatDateTime,
  formatEnergyWh,
  paymentStatusBadgeVariant,
  sessionStatusBadgeVariant,
} from "@/lib/utils"

const COST_ROWS: Array<{ key: "energyCostCents" | "timeCostCents" | "idleFeeCents" | "sessionFeeCents" | "minChargeAdjustmentCents"; label: string }> = [
  { key: "energyCostCents", label: "Energia" },
  { key: "timeCostCents", label: "Tempo" },
  { key: "idleFeeCents", label: "Ociosidade" },
  { key: "sessionFeeCents", label: "Taxa fixa" },
  { key: "minChargeAdjustmentCents", label: "Ajuste de cobrança mínima" },
]

/**
 * `/app/sessoes/:id` — o recibo. Decomposição linha a linha do custo (só as
 * linhas que a tarifa usada de fato gerou — os outros campos vêm `null`,
 * não `0`, e omitir a linha inteira é mais claro que mostrar "R$0,00" pra
 * algo que nem se aplica a este modelo de tarifa).
 *
 * `justCompleted` (vindo de `Sessao.tsx` só na navegação logo após parar)
 * é o único gatilho do convite de instalação — nunca em visitas posteriores
 * ao histórico.
 */
export function SessaoDetalhe() {
  const { id } = useParams<{ id: string }>()
  const location = useLocation()
  const justCompleted = !!(location.state as { justCompleted?: boolean } | null)?.justCompleted

  const { data: session, isLoading, isError, error, refetch } = useMeSessionDetail(id)

  // F5.9: o recibo agora também é a tela de uma sessão que ainda NÃO fechou (`STOP_UNCONFIRMED`) — nesse estado não há
  // valor final, então "Recarga concluída", o detalhamento de custo e o convite de instalação não se aplicam.
  const closureNotice = session ? getDriverClosureNotice(session) : null
  const isStopped = session?.status === "STOPPED"
  const isUnconfirmed = session?.status === "STOP_UNCONFIRMED"
  const isReanimated = !!session && isActiveSessionStatus(session.status)

  return (
    <div>
      <AppBand back={{ to: "/app/sessoes", label: "Histórico" }} className="pb-6">
        {isLoading && (
          // min-h = a altura do bloco real (título + identificador + forma de pagamento): o miolo não se desloca quando o recibo chega (CLS).
          <div className="min-h-[6.75rem] space-y-3" aria-hidden="true">
            <Skeleton className="h-6 w-1/2 rounded-md bg-white/10" />
            <Skeleton className="h-4 w-2/3 rounded-md bg-white/10" />
          </div>
        )}

        {!isLoading && !isError && session && (
          <>
            {/* Momento de marca (D3): o fim de uma recarga é o único lugar do app em que o robô comemora. o pop é de um tiro só. */}
            {justCompleted && isStopped && (
              <div className="glass animate-fade-in-up mb-4 flex items-center gap-3 rounded-2xl px-4 py-3">
                <span className="relative shrink-0">
                  <span className="flex h-14 w-14 items-center justify-center rounded-full bg-white/10 ring-1 ring-white/15">
                    <MascotFace size={56} />
                  </span>
                  <CheckCircle2 className="animate-pop-in absolute -bottom-1 -right-1 h-6 w-6 rounded-full bg-night text-lime" aria-hidden="true" />
                </span>
                <p className="text-base font-extrabold text-white">Recarga concluída</p>
              </div>
            )}

            {/* O selo de status fica SEMPRE numa linha própria, abaixo do título: o badge "Encerramento em confirmação" (F5.9) é longo e ao lado do título espremia o nome do eletroposto e quebrava o identificador do carregador em 375px (medido). Altura fixa também mantém o CLS em zero quando o recibo chega. */}
            <div>
              <h1 className="truncate text-lg font-black tracking-tight text-ink">{session.site.name}</h1>
              <p className="text-sm text-ink-softer">
                {session.chargePoint.ocppIdentity} · Conector {session.connector.connectorId}
              </p>
              <div className="mt-1">
                <SessionPaymentMethodBadge paymentMode={session.paymentMode} payment={session.payment} />
              </div>
              <Badge variant={sessionStatusBadgeVariant(session.status)} className="mt-2.5 whitespace-nowrap">
                {CHARGING_SESSION_STATUS_LABELS[session.status]}
              </Badge>
            </div>
          </>
        )}
      </AppBand>

      <div className="mx-auto max-w-md px-4 pb-5">
        {isError && (
          <ErrorState
            className="mt-5"
            tone="page"
            art={<MascotFace size={64} />}
            message={getApiErrorMessage(error, "Não foi possível carregar o recibo.")}
            onRetry={() => refetch()}
          />
        )}

        {isLoading && (
          <div className="mt-4 space-y-4" aria-hidden="true">
            <Skeleton className="h-32 rounded-2xl" />
            <Skeleton className="h-60 rounded-2xl" />
          </div>
        )}

        {!isLoading && !isError && session && (
          <>
            {closureNotice && <SessionClosureNotice notice={closureNotice} />}

            {isReanimated && (
              <Link
                to="/app/sessao"
                className="animate-fade-in-up mt-4 flex items-center gap-3 rounded-2xl bg-lime/15 p-4 text-sm font-bold text-ink ring-1 ring-lime/50 transition-colors hover:bg-lime/25 active:scale-[0.99]"
              >
                <Zap className="h-5 w-5 shrink-0 text-accent-700" aria-hidden="true" />
                <span className="min-w-0">
                  {DRIVER_CLOSURE_COPY.reanimated} <span className="underline">{DRIVER_CLOSURE_COPY.reanimatedLink}</span>
                </span>
              </Link>
            )}

            <Card className="animate-fade-in-up mt-4">
              <CardContent className="grid grid-cols-2 gap-4 p-5 sm:p-5">
                <div>
                  <p className="text-[10px] font-bold uppercase tracking-wide text-ink-softer">Início</p>
                  <p className="text-sm font-semibold text-ink">{formatDateTime(session.startedAt)}</p>
                </div>
                <div>
                  <p className="text-[10px] font-bold uppercase tracking-wide text-ink-softer">Fim</p>
                  <p className="text-sm font-semibold text-ink">{formatDateTime(session.stoppedAt)}</p>
                </div>
                <div>
                  <p className="text-[10px] font-bold uppercase tracking-wide text-ink-softer">Energia</p>
                  <p className="text-sm font-semibold text-ink">{formatEnergyWh(session.energyDeliveredWh)}</p>
                </div>
                <div>
                  <p className="text-[10px] font-bold uppercase tracking-wide text-ink-softer">Tarifa</p>
                  <p className="truncate text-sm font-semibold text-ink">{session.tariff.name}</p>
                </div>
              </CardContent>
            </Card>

            {/* Sem valor final enquanto confirma: o aviso acima já diz que nada foi cobrado — mostrar "Total R$ 0,00" aqui seria uma afirmação falsa. */}
            {!isUnconfirmed && !isReanimated && (
              <Card className="stagger-1 animate-fade-in-up mt-4">
                <CardContent className="p-5 sm:p-5">
                  <p className="mb-3 text-xs font-bold uppercase tracking-wide text-ink-softer">Detalhamento do custo</p>
                  <dl className="space-y-2">
                    {COST_ROWS.filter((row) => session[row.key] !== null).map((row) => (
                      <div key={row.key} className="flex items-center justify-between text-sm">
                        <dt className="text-ink-softer">{row.label}</dt>
                        <dd className="font-semibold text-ink">{formatCents(session[row.key])}</dd>
                      </div>
                    ))}
                    <div className="flex items-center justify-between border-t border-border-subtle pt-2.5 text-base">
                      <dt className="font-bold text-ink">Total</dt>
                      <dd className="text-xl font-black tracking-tight text-primary-700">{formatCents(session.totalCostCents)}</dd>
                    </div>
                  </dl>

                  {session.paymentMode === "CARD" ? (
                    session.payment?.card ? (
                      <div className="mt-4 space-y-2 rounded-2xl bg-muted px-4 py-3">
                        <div className="flex items-center justify-between">
                          <span className="text-xs font-semibold text-ink-softer">Cartão</span>
                          <span className="text-sm font-bold text-ink">
                            {session.payment.card.brand} •••• {session.payment.card.last4 ?? "----"}
                          </span>
                        </div>
                        <div className="flex flex-wrap items-center justify-between gap-y-1">
                          <span className="text-xs font-semibold text-ink-softer">Status da cobrança</span>
                          {/* `whitespace-nowrap` — o rótulo é uma frase longa ("Cobrança em
                              processamento"); sem isso o texto quebra DENTRO do badge e o
                              pill vira um retângulo espremido (achado tirando screenshot em
                              390px). `flex-wrap` no container deixa o badge INTEIRO cair pra
                              próxima linha quando não cabe ao lado do rótulo, em vez de
                              espremer o texto dentro dele. */}
                          <Badge variant={paymentStatusBadgeVariant(session.payment.card.status)} className="whitespace-nowrap">
                            {SESSION_CARD_CAPTURE_STATUS_LABELS[session.payment.card.status]}
                          </Badge>
                        </div>
                        {session.payment.card.capturedCents !== null && (
                          <div className="flex items-center justify-between">
                            <span className="text-xs font-semibold text-ink-softer">Valor cobrado</span>
                            <span className="text-sm font-bold text-ink">{formatCents(session.payment.card.capturedCents)}</span>
                          </div>
                        )}
                      </div>
                    ) : (
                      <p className="mt-4 rounded-2xl bg-muted px-4 py-3 text-xs text-ink-softer">A cobrança ainda está sendo processada.</p>
                    )
                  ) : session.walletEntry ? (
                    <div className="mt-4 flex items-center justify-between rounded-2xl bg-muted px-4 py-3">
                      <span className="text-xs font-semibold text-ink-softer">Novo saldo da carteira</span>
                      <span className="text-sm font-black text-ink">{formatCents(session.walletEntry.balanceAfterCents)}</span>
                    </div>
                  ) : (
                    <p className="mt-4 rounded-2xl bg-muted px-4 py-3 text-xs text-ink-softer">A cobrança ainda está sendo processada.</p>
                  )}

                  {session.debt && (
                    <p className="mt-3 flex items-start gap-2 rounded-2xl bg-danger-50 px-4 py-3 text-xs font-semibold text-danger-700">
                      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
                      {formatCents(session.debt.amountCents)} ficaram em aberto — quite na carteira para poder carregar de novo.
                    </p>
                  )}
                </CardContent>
              </Card>
            )}

            {justCompleted && isStopped && (
              <div className="mt-4">
                <InstallPromptCard />
              </div>
            )}
          </>
        )}
      </div>
    </div>
  )
}
