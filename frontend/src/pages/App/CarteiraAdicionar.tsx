import { useEffect, useRef, useState } from "react"
import { Link } from "react-router-dom"
import { useQueryClient } from "@tanstack/react-query"
import { ArrowLeft, QrCode, RotateCcw } from "lucide-react"
import { MascotFace } from "@/components/brand/Mascot"
import { AppBand } from "@/components/pwa/AppBand"
import { Button } from "@/components/ui/Button"
import { IconBadge } from "@/components/ui/IconBadge"
import { buttonVariants } from "@/components/ui/buttonVariants"
import { ErrorState } from "@/components/ui/ErrorState"
import { Skeleton } from "@/components/ui/Skeleton"
import { TopupAmountPicker } from "@/components/carteira/TopupAmountPicker"
import { TopupPendingCard } from "@/components/carteira/TopupPendingCard"
import { TopupSuccessCard } from "@/components/carteira/TopupSuccessCard"
import { useCreateTopup, useMeTopup, useMeWallet } from "@/hooks/useMeSessions"
import { getApiErrorCode, getApiErrorMessage } from "@/services/api"
import { createTopupErrorMessage } from "@/lib/topupAmount"
import { isGatewayDisabledError, PIX_GATEWAY_DISABLED_MESSAGE } from "@/lib/paymentMethodDisabled"

/**
 * `/app/carteira/adicionar` — recarga de saldo via Pix (F5.1). Três passos
 * DERIVADOS de um único `topupId` local + a query do topup (nunca
 * sincronizados por `useEffect`+`setState`, mesmo padrão de `Sessao.tsx`):
 * nenhum id → escolher valor; id + `PENDING` → QR/copia-e-cola; `PAID` →
 * sucesso; `EXPIRED`/`FAILED` → tentar de novo.
 *
 * A rota real (`POST/GET /api/me/wallet/topups`) ainda NÃO existe no backend
 * — validado só contra o mock MSW (`mocks/meData.ts`/`handlers.ts`), ver
 * handoff.
 */
export function CarteiraAdicionar() {
  const queryClient = useQueryClient()
  const [topupId, setTopupId] = useState<string | null>(null)

  const walletQuery = useMeWallet({ pageSize: 1 })
  const createTopup = useCreateTopup()
  const topupQuery = useMeTopup(topupId)
  const topup = topupQuery.data

  // Pix confirmado: a carteira já foi creditada no servidor a essa altura —
  // sem invalidar aqui, a tela de sucesso (e a Carteira, se o motorista voltar
  // pra ela) mostrariam o saldo ANTIGO até o `staleTime` global vencer sozinho
  // (mesmo achado documentado em `useStopSession`/`Sessao.tsx`). Efeito colateral
  // de verdade (nunca sincroniza estado local a partir da query — só dispara a
  // invalidação uma vez por topup, via `paidHandledRef`), por isso mora num
  // `useEffect`, não no corpo do render.
  const paidHandledRef = useRef<string | null>(null)
  useEffect(() => {
    if (topup?.status === "PAID" && paidHandledRef.current !== topup.id) {
      paidHandledRef.current = topup.id
      queryClient.invalidateQueries({ queryKey: ["me", "wallet"] })
    }
  }, [topup?.status, topup?.id, queryClient])

  // O ADMIN desligou o Pix (409 `PAYMENT_METHOD_DISABLED` + `GATEWAY_DISABLED`): derivado do erro da
  // mutação, sem estado extra. A tela troca o formulário por um aviso SEM botão de tentar de novo
  // (repetir só devolveria o mesmo 409); sair e voltar à tela reinicia o estado.
  const pixUnavailable = createTopup.isError && isGatewayDisabledError(createTopup.error)

  const handleCreate = async (amountCents: number, cpf: string | undefined) => {
    try {
      const created = await createTopup.mutateAsync({ amountCents, cpf })
      setTopupId(created.id)
    } catch {
      // Erro tratado abaixo via `createTopup.error` — nada a fazer aqui.
    }
  }

  const handleRetry = () => {
    paidHandledRef.current = null
    setTopupId(null)
    createTopup.reset()
  }

  return (
    <div>
      {topupId ? (
        // Pix gerado/confirmado: o momento de marca é o próprio cartão do passo (QR, sucesso, erro) — a faixa escura aqui empilharia dois blocos escuros.
        <div className="mx-auto max-w-md px-4 pt-3">
          <Link to="/app/carteira" className="inline-flex min-h-11 items-center gap-1.5 text-sm font-semibold text-ink-softer hover:text-ink">
            <ArrowLeft className="h-4 w-4" aria-hidden="true" />
            Carteira
          </Link>
        </div>
      ) : (
        <AppBand back={{ to: "/app/carteira", label: "Carteira" }} className="pb-8">
          <div className="animate-fade-in-up flex items-start gap-3">
            <IconBadge icon={QrCode} size="lg" tone="onDark" />
            <div>
              <h1 className="text-lg font-black tracking-tight text-ink">Adicionar saldo</h1>
              <p className="text-sm text-ink-softer">Escolha o valor e pague com Pix — o saldo cai na hora.</p>
            </div>
          </div>
        </AppBand>
      )}

      <div className="mx-auto max-w-md px-4 pb-5">
        {!topupId && (
          <div className="mt-5">
            {walletQuery.isLoading && (
              <div className="space-y-3" aria-hidden="true">
                <Skeleton className="h-12 rounded-xl" />
                <Skeleton className="h-24 rounded-2xl" />
              </div>
            )}

            {walletQuery.isError && (
              <ErrorState
                tone="page"
                art={<MascotFace size={64} />}
                message={getApiErrorMessage(walletQuery.error, "Não foi possível carregar sua carteira.")}
                onRetry={() => walletQuery.refetch()}
              />
            )}

            {!walletQuery.isLoading && !walletQuery.isError && pixUnavailable && (
              <div
                role="alert"
                data-testid="pix-unavailable"
                className="surface-dark flex flex-col items-center rounded-3xl bg-gradient-to-br from-primary-950 to-primary-800 px-6 py-10 text-center shadow-tinted-card ring-1 ring-white/10"
              >
                <span className="flex h-16 w-16 items-center justify-center rounded-full bg-white/10 ring-1 ring-white/15">
                  <MascotFace size={64} />
                </span>
                <p className="mt-4 text-base font-black text-ink">{PIX_GATEWAY_DISABLED_MESSAGE}</p>
                <Link to="/app/carteira" className={buttonVariants({ variant: "glass", className: "mt-5 w-full" })}>
                  Voltar à carteira
                </Link>
              </div>
            )}

            {!walletQuery.isLoading && !walletQuery.isError && !pixUnavailable && (
              <TopupAmountPicker
                openDebtCents={walletQuery.data?.openDebtCents ?? 0}
                loading={createTopup.isPending}
                serverError={createTopup.isError ? createTopupErrorMessage(getApiErrorCode(createTopup.error)) : null}
                onSubmit={handleCreate}
              />
            )}
          </div>
        )}

        {topupId && topupQuery.isLoading && (
          <div className="space-y-3 py-8" aria-hidden="true">
            <Skeleton className="mx-auto h-6 w-40 rounded-full" />
            <Skeleton className="h-64 rounded-2xl" />
          </div>
        )}

        {topupId && topupQuery.isError && (
          <ErrorState
            className="mt-4"
            tone="page"
            art={<MascotFace size={64} />}
            message={getApiErrorMessage(topupQuery.error, "Não foi possível consultar o Pix.")}
            onRetry={() => topupQuery.refetch()}
          />
        )}

        {topup?.status === "PENDING" && <TopupPendingCard topup={topup} />}

        {topup?.status === "PAID" && <TopupSuccessCard topup={topup} walletBalanceCents={walletQuery.data?.balanceCents} />}

        {topup?.status === "EXPIRED" && (
          <div className="surface-dark mt-5 flex flex-col items-center rounded-3xl bg-gradient-to-br from-primary-950 to-primary-800 px-6 py-10 text-center shadow-tinted-card ring-1 ring-white/10">
            <span className="flex h-16 w-16 items-center justify-center rounded-full bg-white/10 ring-1 ring-white/15">
              <MascotFace size={64} />
            </span>
            <h1 className="mt-4 text-lg font-black text-ink">O Pix expirou</h1>
            <p className="mt-1 text-sm text-ink-softer">Você não pagou dentro dos 30 minutos. Gere um novo código para tentar de novo.</p>
            <Button type="button" variant="lime" size="lg" className="mt-5 w-full" onClick={handleRetry}>
              <RotateCcw className="h-4 w-4" aria-hidden="true" />
              Gerar novo Pix
            </Button>
          </div>
        )}

        {topup?.status === "FAILED" && (
          <div className="surface-dark mt-5 flex flex-col items-center rounded-3xl bg-gradient-to-br from-primary-950 to-primary-800 px-6 py-10 text-center shadow-tinted-card ring-1 ring-white/10">
            <span className="flex h-16 w-16 items-center justify-center rounded-full bg-white/10 ring-1 ring-white/15">
              <MascotFace size={64} />
            </span>
            <h1 className="mt-4 text-lg font-black text-ink">O pagamento falhou</h1>
            <p className="mt-1 text-sm text-ink-softer">Não foi possível confirmar este Pix. Nenhum valor foi cobrado — tente gerar um novo código.</p>
            <Button type="button" variant="lime" size="lg" className="mt-5 w-full" onClick={handleRetry}>
              <RotateCcw className="h-4 w-4" aria-hidden="true" />
              Tentar novamente
            </Button>
          </div>
        )}
      </div>
    </div>
  )
}
