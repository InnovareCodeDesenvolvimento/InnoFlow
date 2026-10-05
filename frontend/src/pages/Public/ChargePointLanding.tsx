import { useState } from "react"
import { Link, useNavigate, useParams } from "react-router-dom"
import { useQueryClient } from "@tanstack/react-query"
import { AlertCircle, CreditCard, LogIn, LogOut, MapPin, UserX, Zap } from "lucide-react"
import { Badge } from "@/components/ui/Badge"
import { Button } from "@/components/ui/Button"
import { buttonVariants } from "@/components/ui/buttonVariants"
import { Card, CardContent } from "@/components/ui/Card"
import { EmptyState } from "@/components/ui/EmptyState"
import { ErrorState } from "@/components/ui/ErrorState"
import { BrandBackdrop } from "@/components/brand/BrandBackdrop"
import { MascotFace } from "@/components/brand/Mascot"
import { Skeleton } from "@/components/ui/Skeleton"
import { ConnectorPickerCard } from "@/components/chargePoint/ConnectorPickerCard"
import { PaymentMethodSelector, type PaymentSelection } from "@/components/chargePoint/PaymentMethodSelector"
import { usePublicChargePoint } from "@/hooks/usePublicChargePoint"
import { useMeWallet, useStartSession } from "@/hooks/useMeSessions"
import { useMePaymentMethods, paymentMethodsKeys } from "@/hooks/useMePaymentMethods"
import { useAuthStore } from "@/store/authStore"
import { getApiErrorCode, getApiErrorMessage } from "@/services/api"
import { CARD_GATEWAY_DISABLED_START_MESSAGE, isGatewayDisabledError } from "@/lib/paymentMethodDisabled"
import { CardEligibilityNotice } from "@/components/carteira/CardEligibilityNotice"
import { issueErrorMessage, issueFromEligibility, issueFromError, type CardEligibilityIssue } from "@/lib/cardEligibility"
import { CONNECTOR_TYPE_LABELS, formatCents, formatPowerKw, formatTariffHeadlinePrice, landingConnectorStatus, ROLE_LABELS } from "@/lib/utils"

/**
 * `/c/:ocppIdentity` (+ `:connectorId` opcional) — a tela MAIS importante do
 * produto: o motorista acabou de escanear o QR do adesivo colado no
 * carregador, em pé do lado do carro, SEM contexto nenhum sobre a marca
 * (a primeira vez que essa pessoa vê a InnoFlow pode ser esta tela). Regra de
 * layout (não é estética, é requisito): informação essencial acima da dobra,
 * sem scroll, sem spinner longo — por isso o wrapper é próprio (sem Header/
 * Footer do site público), um único card, coluna estreita (`max-w-md`) mesmo
 * em telas maiores.
 *
 * Passe visual de 17/09/2026 (veredito do dono vendo a v1 ao vivo: "muito
 * feia e fraca, sem nada de interessante"): a v1 tinha um card pequeno
 * centralizado por `justify-center` numa coluna alta — isso CRIA vazio em
 * cima E embaixo por construção (centralizar algo curto num container alto
 * sobra espaço nas duas pontas), e os blobs decorativos em 10% de opacidade
 * sobre fundo CLARO eram baixo contraste demais pra sequer aparecer num
 * screenshot. A v2 substitui isso por uma faixa de herói (mesmo gradiente
 * escuro do painel de marca do Login) com o slogan oficial em destaque — o
 * card não fica mais sozinho no vazio, ele "flutua" por cima da fronteira do
 * herói (`-mt-8`), e os blobs, sobre fundo ESCURO e em opacidade maior,
 * finalmente aparecem. Sem `justify-center`: o fluxo é do topo pra baixo,
 * então o card fica logo abaixo do herói, não centralizado numa coluna vazia.
 */
export function ChargePointLanding() {
  const { ocppIdentity = "", connectorId } = useParams<{ ocppIdentity: string; connectorId?: string }>()
  const navigate = useNavigate()
  const { data: cp, isLoading, isError, error, refetch } = usePublicChargePoint(ocppIdentity)
  const { isAuthenticated, user, logout } = useAuthStore()
  const isDriver = isAuthenticated && user?.role === "DRIVER"

  // pageSize:1 — só precisamos de balanceCents/openDebtCents aqui, não do
  // extrato. `enabled: isDriver` evita bater na rota DRIVER-only para
  // visitante anônimo ou conta ADMIN/OPERATOR.
  const { data: wallet } = useMeWallet({ pageSize: 1 }, isDriver)
  const startSession = useStartSession()
  const [startError, setStartError] = useState<string | null>(null)
  const queryClient = useQueryClient()

  // Cartão salvo (F5.4, ver `.claude/agent-memory/nova/decisoes-f5-pagamento-cielo.md`
  // §2) — mesma regra de `enabled` do saldo acima. `userPaymentSelection` só
  // guarda uma escolha depois que o motorista de fato toca num radio; até lá
  // a seleção EFETIVA é DERIVADA (cartão padrão se existir, senão Carteira) —
  // sem `useEffect` sincronizando estado a partir da query (mesmo raciocínio
  // de `Sessao.tsx`: tudo calculado durante o render). Isso também resolve
  // sozinho o caso "cartão escolhido sumiu" (`PAYMENT_METHOD_NOT_FOUND`): ao
  // invalidar a lista, a escolha stale deixa de bater em nenhum método e a
  // seleção derivada volta pro padrão/Carteira no próximo render, sem precisar
  // resetar `userPaymentSelection` manualmente.
  const { data: paymentMethodsData } = useMePaymentMethods(isDriver)
  const paymentMethods = paymentMethodsData?.items ?? []
  const [userPaymentSelection, setUserPaymentSelection] = useState<PaymentSelection | null>(null)
  // O ADMIN desligou o MEIO cartão (409 `PAYMENT_METHOD_DISABLED` + `reason: GATEWAY_DISABLED`).
  // Não existe endpoint para saber de antemão, então só se descobre ao tentar: daí em diante,
  // nesta sessão da tela, o seletor some e a seleção efetiva é sempre Carteira. Estado local
  // de propósito (não é do servidor nem compartilhado): recarregar a página tenta o cartão de novo.
  const [cardGatewayDisabled, setCardGatewayDisabled] = useState(false)
  // I-7: cartão exige identidade verificada (login Google) e some por um tempo depois de recusas em excesso. Vem do GET (`cardEligibility`) e, se o
  // servidor recusar ao iniciar (403/429 - o bloqueio pode ter começado depois do GET), do próprio erro; o que o servidor acabou de dizer manda.
  // Carteira e Pix não são afetados: com problema de cartão a seleção efetiva é sempre Carteira e o botão "Iniciar recarga" segue normal.
  const [serverCardIssue, setServerCardIssue] = useState<CardEligibilityIssue | null>(null)
  const cardIssue = serverCardIssue ?? issueFromEligibility(paymentMethodsData?.cardEligibility)
  const defaultPaymentMethod = paymentMethods.find((m) => m.isDefault)
  const paymentSelectionIsValid =
    !!userPaymentSelection &&
    (userPaymentSelection.mode === "WALLET" || paymentMethods.some((m) => m.id === userPaymentSelection.paymentMethodId))
  const paymentSelection: PaymentSelection = cardGatewayDisabled || cardIssue
    ? { mode: "WALLET" }
    : paymentSelectionIsValid && userPaymentSelection
      ? userPaymentSelection
      : defaultPaymentMethod
        ? { mode: "CARD", paymentMethodId: defaultPaymentMethod.id }
        : { mode: "WALLET" }

  const redirectTarget = `/c/${encodeURIComponent(ocppIdentity)}${connectorId ? `/${connectorId}` : ""}`

  const handleStart = async (targetConnectorId: number) => {
    if (!cp) return
    setStartError(null)
    try {
      const result = await startSession.mutateAsync({ ocppIdentity: cp.ocppIdentity, connectorId: targetConnectorId, payment: paymentSelection })
      const selectedCard = paymentSelection.mode === "CARD" ? paymentMethods.find((m) => m.id === paymentSelection.paymentMethodId) : undefined
      navigate("/app/sessao", {
        state: {
          correlationId: result.correlationId,
          paymentMode: result.paymentMode,
          authorizedCents: result.authorizedCents,
          cardBrand: selectedCard?.brand,
          cardLast4: selectedCard?.last4,
        },
      })
    } catch (err) {
      if (getApiErrorCode(err) === "ALREADY_HAS_ACTIVE_SESSION") {
        navigate("/app/sessao")
        return
      }
      const code = getApiErrorCode(err)
      const issue = issueFromError(err)
      if (issue) {
        // 403 CARD_REQUIRES_VERIFIED_IDENTITY / 403 CARD_CHARGEBACK_BLOCKED / 429 CARD_TEMPORARILY_BLOCKED: o seletor some, o card explica e a carteira fica selecionada.
        setServerCardIssue(issue)
        queryClient.invalidateQueries({ queryKey: paymentMethodsKeys.list })
        // Chargeback (403 CARD_CHARGEBACK_BLOCKED): o card explicativo já traz o texto da API inteiro - repeti-lo num alerta ao lado seria o mesmo parágrafo duas vezes.
        setStartError(issue.reason === "CHARGEBACK_BLOCKED" ? null : issueErrorMessage(issue))
        return
      }
      if (code === "PAYMENT_METHOD_NOT_FOUND") {
        // Cartão pode ter sido removido em outra aba — recarrega a lista (a
        // seleção derivada acima volta sozinha pro padrão/Carteira) e pede
        // pra escolher de novo, sem perder o resto da tela.
        queryClient.invalidateQueries({ queryKey: paymentMethodsKeys.list })
        setStartError("Esse cartão não está mais disponível. Escolha outro cartão ou a carteira e tente de novo.")
        return
      }
      if (code === "PAYMENT_METHOD_DISABLED" && isGatewayDisabledError(err)) {
        // Sentido 2: não é "cartão desativado" — o meio todo está fora. A mensagem
        // persistente (no lugar do seletor) é renderizada a partir deste estado.
        setCardGatewayDisabled(true)
        setStartError(null)
        return
      }
      if (code === "PAYMENT_METHOD_DISABLED") {
        queryClient.invalidateQueries({ queryKey: paymentMethodsKeys.list })
        setStartError("Este cartão foi desativado. Escolha outro cartão ou a carteira e tente de novo.")
        return
      }
      if (code === "CARD_AUTHORIZATION_DENIED") {
        setStartError("Seu cartão foi recusado. Tente outro cartão ou use a carteira.")
        return
      }
      if (code === "PAYMENT_GATEWAY_UNAVAILABLE") {
        setStartError("Não foi possível processar o pagamento agora. Tente novamente ou use a carteira.")
        return
      }
      setStartError(getApiErrorMessage(err, "Não foi possível iniciar a recarga. Tente novamente."))
    }
  }

  // Estado "logado, mas não é motorista" (ex.: admin/operador testando o QR)
  // ficava travado sem saída óbvia — só um parágrafo cinza. Agora oferece a
  // ação de verdade: sair da conta atual e ir pro login já com o redirect de
  // volta pra ESTE carregador, pra não perder o contexto do QR escaneado.
  const handleSwitchAccount = () => {
    logout()
    navigate(`/login?redirect=${encodeURIComponent(redirectTarget)}`)
  }

  return (
    <div className="relative flex min-h-screen flex-col overflow-hidden bg-background">
      {/* Herói de marca — faixa cheia no topo (mesmo gradiente escuro do
          painel de marca do Login), não um wash quase invisível. O slogan
          oficial mora AQUI, é a primeira coisa que um motorista desconhecido
          vê ao escanear o QR. Altura contida de propósito (a regra "acima da
          dobra, sem scroll" continua valendo) — o impacto vem da COR/
          conteúdo, não de ocupar mais tela. */}
      <div className="surface-dark surface-dark-rich relative shrink-0 overflow-hidden px-4 pb-14 pt-6 text-center">
        <BrandBackdrop />
        <div className="relative z-10 mx-auto flex max-w-md flex-col items-center gap-2">
          <div className="flex items-center gap-2.5">
            <MascotFace size={40} className="rounded-full bg-white/10 ring-1 ring-white/15" />
            <span className="text-base font-extrabold tracking-tight text-white">InnoFlow</span>
          </div>
          <p className="text-xl font-extrabold leading-snug tracking-tight text-white sm:text-2xl">
            Carregue um <span className="bg-gradient-to-r from-lime to-primary-300 bg-clip-text text-transparent">futuro melhor</span>.
          </p>
        </div>
      </div>

      {/* SEM `justify-center`: o conteúdo fica logo abaixo do herói (fluxo do
          topo pra baixo), não centralizado numa coluna vazia — era exatamente
          isso que criava vazio em cima E embaixo na v1. O "flutuar por cima
          da fronteira do herói" (`-mt-8`) é aplicado SÓ no Card do conector
          selecionado (só ele tem fundo branco cobrindo a sobreposição) — os
          outros estados (loading/erro/escolha de conector) não têm essa
          margem negativa, senão o texto nascia direto em cima do gradiente
          escuro do herói, ilegível (achado testando esta própria versão). */}
      <main className="relative z-10 mx-auto w-full max-w-md flex-1 px-4 pb-6">
        {isLoading && (
          <div className="space-y-3" aria-hidden="true">
            <Skeleton className="h-5 w-2/3 rounded-md" />
            <Skeleton className="h-40 rounded-card" />
          </div>
        )}

        {isError && (
          <ErrorState
            message={getApiErrorMessage(error, "Não foi possível encontrar este carregador. Confira o QR code e tente de novo.")}
            onRetry={() => refetch()}
            art={<MascotFace size={64} />}
          />
        )}

        {!isLoading && !isError && cp && cp.connectors.length === 0 && (
          <EmptyState tone="brand" icon={Zap} title="Sem conectores cadastrados" description="Este ponto de recarga ainda não tem conectores configurados." art={<MascotFace size={64} />} />
        )}

        {!isLoading && !isError && cp && cp.connectors.length > 0 && !connectorId && cp.connectors.length > 1 && (
          <div>
            <h1 className="text-lg font-black tracking-tight text-ink">{cp.site.name}</h1>
            <p className="mb-4 mt-1 text-sm text-ink-softer">Este carregador tem mais de um conector — escolha o seu.</p>
            <div className="space-y-3">
              {cp.connectors.map((c) => (
                <ConnectorPickerCard key={c.connectorId} ocppIdentity={cp.ocppIdentity} connector={c} />
              ))}
            </div>
          </div>
        )}

        {!isLoading &&
          !isError &&
          cp &&
          cp.connectors.length > 0 &&
          (() => {
            const selected = connectorId
              ? cp.connectors.find((c) => c.connectorId === Number(connectorId))
              : cp.connectors.length === 1
                ? cp.connectors[0]
                : undefined
            if (!selected) {
              if (connectorId) {
                return <ErrorState message="Conector não encontrado neste carregador." art={<MascotFace size={64} />} />
              }
              return null
            }

            const status = landingConnectorStatus(cp.online, selected.status)
            const isOffline = status.label === "Fora do ar"
            const hasOpenDebt = isDriver && (wallet?.openDebtCents ?? 0) > 0

            return (
              // `-mt-8`: só este card tem fundo branco cobrindo a
              // sobreposição com o herói (ver comentário do `<main>` acima)
              // — "flutua" por cima da fronteira em vez de nascer colado
              // nela, evitando o vazio entre o herói e o card.
              <Card className="animate-enter -mt-8 shadow-tinted-card">
                <CardContent className="p-5">
                  <p className="text-xs font-bold uppercase tracking-wide text-ink-softer">{cp.site.name}</p>
                  {(cp.site.addressLine || cp.site.city) && (
                    <p className="mt-0.5 flex items-start gap-1.5 text-sm text-ink-softer">
                      <MapPin className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                      <span className="truncate">
                        {[cp.site.addressLine, cp.site.city && cp.site.state ? `${cp.site.city}/${cp.site.state}` : cp.site.city]
                          .filter(Boolean)
                          .join(" — ")}
                      </span>
                    </p>
                  )}

                  <div className="mt-4 flex items-center justify-between gap-3">
                    <div className="flex min-w-0 items-center gap-3">
                      <span className="flex h-14 w-14 shrink-0 items-center justify-center rounded-card bg-primary/10 text-2xl font-black text-primary-700">
                        {selected.connectorId}
                      </span>
                      <div className="min-w-0">
                        {/* O número do conector já está no badge grande à esquerda — repeti-lo aqui como texto só ocupava espaço e cortava o tipo (achado testando em 390px, ver `[[medir-antes-de-afirmar]]`). */}
                        <p className="truncate text-sm font-bold text-ink" title={CONNECTOR_TYPE_LABELS[selected.type]}>
                          {CONNECTOR_TYPE_LABELS[selected.type]}
                        </p>
                        <p className="text-xs text-ink-softer">{formatPowerKw(selected.maxPowerKw)}</p>
                      </div>
                    </div>
                    <Badge variant={status.variant} className="shrink-0">
                      {status.label}
                    </Badge>
                  </div>

                  {selected.tariff ? (
                    <div className="mt-5 rounded-xl bg-primary-50 p-4">
                      <p className="text-2xl font-black tracking-tight text-primary-700">{formatTariffHeadlinePrice(selected.tariff)}</p>
                      {selected.tariff.minChargeCents ? (
                        <p className="mt-2 flex items-start gap-1.5 text-xs font-semibold text-warning-700">
                          <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                          Cobrança mínima de {formatCents(selected.tariff.minChargeCents)} por sessão, mesmo em recargas curtas.
                        </p>
                      ) : null}
                    </div>
                  ) : (
                    <p className="mt-5 rounded-xl bg-muted p-4 text-sm text-ink-softer">Este conector ainda não tem tarifa cadastrada.</p>
                  )}

                  <div className="mt-5 space-y-3">
                    {!isAuthenticated && (
                      <Link
                        to={`/login?redirect=${encodeURIComponent(redirectTarget)}`}
                        className={buttonVariants({ variant: "lime", size: "lg", className: "w-full" })}
                      >
                        <LogIn className="h-4 w-4" aria-hidden="true" />
                        Entrar para carregar
                      </Link>
                    )}

                    {isAuthenticated && !isDriver && (
                      <div className="flex flex-col items-center gap-3 rounded-xl bg-muted px-4 py-5 text-center">
                        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-warning-100 text-warning-700" aria-hidden="true">
                          <UserX className="h-5 w-5" />
                        </span>
                        <div>
                          <p className="text-sm font-bold text-ink">Conta sem acesso à recarga</p>
                          <p className="mt-1 text-xs leading-relaxed text-ink-softer">
                            Você está conectado como {user ? ROLE_LABELS[user.role].toLowerCase() : "outra conta"} — esta função é exclusiva
                            para contas de motorista.
                          </p>
                        </div>
                        <Button type="button" variant="outline" size="sm" onClick={handleSwitchAccount}>
                          <LogOut className="h-3.5 w-3.5" aria-hidden="true" />
                          Sair e entrar com outra conta
                        </Button>
                      </div>
                    )}

                    {isDriver && (
                      <>
                        <div className="flex items-center justify-between rounded-xl bg-muted px-4 py-3">
                          <span className="text-xs font-semibold text-ink-softer">Seu saldo</span>
                          <span className="text-sm font-black text-ink">{formatCents(wallet?.balanceCents)}</span>
                        </div>
                        {hasOpenDebt && (
                          <p className="rounded-xl bg-danger-50 px-4 py-3 text-xs font-semibold text-danger-700">
                            Você tem uma dívida em aberto de {formatCents(wallet?.openDebtCents)}.{" "}
                            <Link to="/app/carteira" className="underline">
                              Regularize na carteira
                            </Link>{" "}
                            para poder carregar de novo.
                          </p>
                        )}
                        {/* Só aparece com 1+ cartão salvo — com 0 cartões o fluxo fica
                            IDÊNTICO ao de sempre (Carteira), sem forçar cadastro. */}
                        {cardGatewayDisabled && (
                          <p role="alert" data-testid="card-gateway-disabled" className="flex items-start gap-2 rounded-xl bg-warning-50 px-4 py-3 text-sm font-medium text-warning-700">
                            <CreditCard className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
                            {CARD_GATEWAY_DISABLED_START_MESSAGE}
                          </p>
                        )}
                        {cardIssue && (paymentMethods.length > 0 || serverCardIssue) && <CardEligibilityNotice issue={cardIssue} onLinked={() => setServerCardIssue(null)} />}
                        {paymentMethods.length > 0 && !cardGatewayDisabled && !cardIssue && (
                          <PaymentMethodSelector methods={paymentMethods} value={paymentSelection} onChange={setUserPaymentSelection} />
                        )}
                        {paymentSelection.mode === "CARD" && (
                          <p className="flex items-start gap-2 rounded-xl bg-muted px-4 py-3 text-xs text-ink-softer">
                            <CreditCard className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                            Faremos uma pré-autorização estimada neste cartão — você só paga pelo que consumir.
                          </p>
                        )}
                        {startError && (
                          <p role="alert" className="rounded-xl bg-danger-50 px-4 py-3 text-sm font-medium text-danger-700">
                            {startError}
                          </p>
                        )}
                        <Button
                          type="button"
                          size="lg"
                          variant="lime"
                          className="w-full"
                          disabled={isOffline || !selected.tariff || hasOpenDebt}
                          loading={startSession.isPending}
                          onClick={() => handleStart(selected.connectorId)}
                        >
                          <Zap className="h-4 w-4" aria-hidden="true" />
                          Iniciar recarga
                        </Button>
                      </>
                    )}
                  </div>
                </CardContent>
              </Card>
            )
          })()}
      </main>
    </div>
  )
}
