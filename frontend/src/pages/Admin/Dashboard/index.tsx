import { useState } from "react"
import {
  AlertTriangle,
  BarChart3,
  BatteryCharging,
  CheckCircle2,
  DollarSign,
  Gauge,
  Receipt,
  Zap,
} from "lucide-react"
import { BrandBackdrop } from "@/components/brand/BrandBackdrop"
import { Mascot, MascotFace } from "@/components/brand/Mascot"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/Card"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/Table"
import { Badge } from "@/components/ui/Badge"
import { EmptyState } from "@/components/ui/EmptyState"
import { AdminErrorState as ErrorState } from "@/components/admin/AdminStates"
import { Skeleton, TableSkeleton } from "@/components/ui/Skeleton"
import { PeriodSelector } from "@/components/relatorios/PeriodSelector"
import { OperatorFilterSelect } from "@/components/relatorios/OperatorFilterSelect"
import { SiteFilterSelect } from "@/components/relatorios/SiteFilterSelect"
import { StatCard } from "@/components/ui/StatCard"
import { RevenueBarChart } from "@/components/relatorios/RevenueBarChart"
import { PaymentSplitDonut } from "@/components/relatorios/PaymentSplitDonut"
import { useDashboardLive, useDashboardSummary } from "@/hooks/useDashboard"
import { useReportPeriod } from "@/hooks/useReportPeriod"
import { useAuthStore } from "@/store/authStore"
import { getApiErrorMessage } from "@/services/api"
import {
  CHARGING_SESSION_STATUS_LABELS,
  formatCents,
  formatDateTime,
  formatEnergyWh,
  formatPercent,
  sessionStatusBadgeVariant,
} from "@/lib/utils"

export default function DashboardPage() {
  const role = useAuthStore((s) => s.user?.role)
  const isAdmin = role === "ADMIN"

  const period = useReportPeriod("30d")
  const [operatorId, setOperatorId] = useState("")
  const [siteId, setSiteId] = useState("")
  const effectiveOperatorId = isAdmin ? operatorId || undefined : undefined

  const { data, isLoading, isError, error, refetch } = useDashboardSummary({
    from: period.from,
    to: period.to,
    siteId: siteId || undefined,
    operatorId: effectiveOperatorId,
  })
  const live = useDashboardLive(effectiveOperatorId)

  const hasRevenueByDay = (data?.revenueByDay ?? []).some((d) => d.revenueCents > 0)

  return (
    <div className="space-y-6">
      {/* Faixa de marca do topo (D3: o mascote abre o painel; nunca sobre dado). É o ÚNICO título da página: o h1 "Dashboard" fica aqui em vez de no PageHeader. */}
      <section className="surface-dark surface-dark-rich relative overflow-hidden rounded-feature px-5 py-6 shadow-tinted-card sm:px-8 sm:py-7">
        <BrandBackdrop />
        <div className="relative z-10 flex items-center gap-4 sm:gap-6">
          <span className="flex h-14 w-14 shrink-0 items-center justify-center rounded-full bg-white/10 ring-1 ring-white/15 lg:hidden" aria-hidden="true">
            <MascotFace size={56} className="rounded-full" />
          </span>
          <div className="min-w-0 flex-1">
            <h1 className="text-xl font-extrabold tracking-tight text-ink sm:text-2xl">Dashboard</h1>
            <p className="mt-1 text-sm text-ink-soft">Visão geral do faturamento e da operação.</p>
          </div>
          <div className="relative hidden shrink-0 lg:block" aria-hidden="true">
            <div className="brand-backlight" />
            <Mascot sizes="120px" className="[--m-h:130px]" />
          </div>
        </div>
      </section>

      <div className="flex flex-wrap items-center gap-3">
        <PeriodSelector preset={period.preset} from={period.from} to={period.to} onPresetChange={period.setPreset} onCustomChange={period.setCustom} />
        {isAdmin && <OperatorFilterSelect value={operatorId} onChange={setOperatorId} />}
        <SiteFilterSelect value={siteId} onChange={setSiteId} operatorId={effectiveOperatorId} />
      </div>

      {/* Esqueleto com a FORMA do conteúdo (KPIs, gráficos, tabelas): com só a linha de KPIs o "Ao vivo", mais abaixo, descia ~600 px quando os dados chegavam (CLS 0,14 a 1440). */}
      {isLoading && (
        <div className="space-y-6" aria-hidden="true">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 2xl:grid-cols-6">
            {Array.from({ length: 6 }).map((_, i) => (
              <Skeleton key={i} className="h-[8.4rem] rounded-card" />
            ))}
          </div>
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
            <Skeleton className="h-[17.2rem] rounded-card lg:col-span-2" />
            <Skeleton className="h-[17.2rem] rounded-card" />
          </div>
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <Skeleton className="h-[20rem] rounded-card" />
            <Skeleton className="h-[20rem] rounded-card" />
          </div>
        </div>
      )}

      {isError && <ErrorState message={getApiErrorMessage(error, "Não foi possível carregar o dashboard.")} onRetry={() => refetch()} />}

      {!isLoading && !isError && data && (
        <>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 2xl:grid-cols-6">
            <StatCard variant="hero" label="Faturamento" value={data.metrics.revenueCents.value} deltaPct={data.metrics.revenueCents.deltaPct} formatValue={(v) => formatCents(v)} icon={DollarSign} />
            <StatCard label="Sessões" value={data.metrics.sessions.value} deltaPct={data.metrics.sessions.deltaPct} formatValue={(v) => v.toLocaleString("pt-BR")} icon={Zap} />
            <StatCard label="Energia" value={data.metrics.energyWh.value} deltaPct={data.metrics.energyWh.deltaPct} formatValue={(v) => formatEnergyWh(v)} icon={BatteryCharging} />
            <StatCard label="Ticket médio" value={data.metrics.avgTicketCents.value} deltaPct={data.metrics.avgTicketCents.deltaPct} formatValue={(v) => formatCents(v)} icon={Receipt} />
            <StatCard label="Taxa de sucesso" value={data.metrics.successRatePct.value} deltaPct={data.metrics.successRatePct.deltaPct} formatValue={(v) => formatPercent(v)} icon={CheckCircle2} />
            <StatCard label="Utilização" value={data.metrics.utilizationPct.value} deltaPct={data.metrics.utilizationPct.deltaPct} formatValue={(v) => formatPercent(v)} icon={Gauge} />
          </div>

          <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
            <Card className="lg:col-span-2">
              <CardHeader>
                <CardTitle>Faturamento por dia</CardTitle>
              </CardHeader>
              <CardContent>
                {hasRevenueByDay ? (
                  <RevenueBarChart data={data.revenueByDay} />
                ) : (
                  <EmptyState icon={BarChart3} title="Sem faturamento no período" description="Nenhuma sessão encerrada gerou receita nesse intervalo." />
                )}
              </CardContent>
            </Card>
            <Card>
              <CardHeader>
                <CardTitle>Cartão × Carteira</CardTitle>
              </CardHeader>
              <CardContent>
                <PaymentSplitDonut cardCents={data.paymentSplit.cardCents} walletCents={data.paymentSplit.walletCents} />
              </CardContent>
            </Card>
          </div>

          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <Card>
              <CardHeader>
                <CardTitle>Top 5 eletropostos</CardTitle>
                <CardDescription>Por faturamento no período</CardDescription>
              </CardHeader>
              <CardContent>
                {data.topSites.length === 0 ? (
                  <EmptyState title="Sem dados no período" description="Nenhum eletroposto faturou nesse intervalo." />
                ) : (
                  <Table density="compact" className="min-w-0">
                    <TableHeader>
                      <TableRow>
                        <TableHead>Eletroposto</TableHead>
                        <TableHead>Sessões</TableHead>
                        <TableHead className="text-right">Faturamento</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {data.topSites.map((s) => (
                        <TableRow key={s.siteId}>
                          <TableCell className="font-semibold text-ink">{s.siteName}</TableCell>
                          <TableCell>{s.sessions}</TableCell>
                          <TableCell className="text-right font-semibold tabular-nums">{formatCents(s.revenueCents)}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                )}
              </CardContent>
            </Card>

            {isAdmin && data.topOperators ? (
              <Card>
                <CardHeader>
                  <CardTitle>Ranking por operador</CardTitle>
                  <CardDescription>Só visível para administradores da plataforma</CardDescription>
                </CardHeader>
                <CardContent>
                  {data.topOperators.length === 0 ? (
                    <EmptyState title="Sem dados no período" />
                  ) : (
                    <Table density="compact" className="min-w-0">
                      <TableHeader>
                        <TableRow>
                          <TableHead>Operador</TableHead>
                          <TableHead>Sessões</TableHead>
                          <TableHead className="text-right">Faturamento</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {data.topOperators.map((o) => (
                          <TableRow key={o.operatorId}>
                            <TableCell className="font-semibold text-ink">{o.operatorName}</TableCell>
                            <TableCell>{o.sessions}</TableCell>
                            <TableCell className="text-right font-semibold tabular-nums">{formatCents(o.revenueCents)}</TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  )}
                </CardContent>
              </Card>
            ) : (
              <Card>
                <CardHeader>
                  <CardTitle>Movimento de hoje</CardTitle>
                  <CardDescription>Por eletroposto</CardDescription>
                </CardHeader>
                <CardContent>
                  {data.todayMovement.length === 0 ? (
                    <EmptyState title="Nenhuma sessão hoje" description="Ainda não houve recarga encerrada hoje neste escopo." />
                  ) : (
                    <Table density="compact" className="min-w-0">
                      <TableHeader>
                        <TableRow>
                          <TableHead>Eletroposto</TableHead>
                          <TableHead>Sessões</TableHead>
                          <TableHead className="text-right">Faturamento</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {data.todayMovement.map((m) => (
                          <TableRow key={m.siteId}>
                            <TableCell className="font-semibold text-ink">{m.siteName}</TableCell>
                            <TableCell>{m.sessions}</TableCell>
                            <TableCell className="text-right font-semibold tabular-nums">{formatCents(m.revenueCents)}</TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  )}
                </CardContent>
              </Card>
            )}
          </div>

          {isAdmin && (
            <Card>
              <CardHeader>
                <CardTitle>Movimento de hoje</CardTitle>
                <CardDescription>Por eletroposto</CardDescription>
              </CardHeader>
              <CardContent>
                {data.todayMovement.length === 0 ? (
                  <EmptyState title="Nenhuma sessão hoje" description="Ainda não houve recarga encerrada hoje neste escopo." />
                ) : (
                  <Table density="compact">
                    <TableHeader>
                      <TableRow>
                        <TableHead>Eletroposto</TableHead>
                        <TableHead>Sessões</TableHead>
                        <TableHead>Energia</TableHead>
                        <TableHead className="text-right">Faturamento</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {data.todayMovement.map((m) => (
                        <TableRow key={m.siteId}>
                          <TableCell className="font-semibold text-ink">{m.siteName}</TableCell>
                          <TableCell>{m.sessions}</TableCell>
                          <TableCell>{formatEnergyWh(m.energyWh)}</TableCell>
                          <TableCell className="text-right font-semibold tabular-nums">{formatCents(m.revenueCents)}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                )}
              </CardContent>
            </Card>
          )}
        </>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Ao vivo</CardTitle>
          <CardDescription>Sessões ativas e status dos carregadores — atualiza a cada 15 segundos</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {live.isLoading && <TableSkeleton cols={5} rows={2} />}
          {live.isError && <ErrorState message={getApiErrorMessage(live.error, "Não foi possível carregar o painel ao vivo.")} onRetry={() => live.refetch()} />}
          {!live.isLoading && !live.isError && live.data && (
            <>
              <div className="flex flex-wrap gap-2" aria-label="Status dos carregadores">
                <Badge variant="success">Online: {live.data.chargePoints.online}</Badge>
                <Badge variant="neutral">Offline: {live.data.chargePoints.offline}</Badge>
                <Badge variant="danger">
                  <AlertTriangle className="h-3 w-3" aria-hidden="true" />
                  Com falha: {live.data.chargePoints.faulted}
                </Badge>
              </div>

              {live.data.activeSessions.length === 0 ? (
                <EmptyState icon={Zap} title="Nenhuma sessão ativa agora" description="Nenhum carregador está em uso neste escopo." />
              ) : (
                <Table density="compact">
                  <TableHeader>
                    <TableRow>
                      <TableHead>Eletroposto</TableHead>
                      <TableHead>Carregador</TableHead>
                      <TableHead>Motorista</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead>Início</TableHead>
                      <TableHead className="text-right">Energia</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {live.data.activeSessions.map((s) => (
                      <TableRow key={s.id}>
                        <TableCell className="font-semibold text-ink">{s.siteName}</TableCell>
                        <TableCell>
                          {s.ocppIdentity} · conector {s.connectorId}
                        </TableCell>
                        <TableCell>{s.driverName}</TableCell>
                        <TableCell>
                          <Badge variant={sessionStatusBadgeVariant(s.status)}>{CHARGING_SESSION_STATUS_LABELS[s.status]}</Badge>
                        </TableCell>
                        <TableCell>{formatDateTime(s.startedAt)}</TableCell>
                        <TableCell className="text-right tabular-nums">{formatEnergyWh(s.energyDeliveredWh)}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
