import { useEffect, useState, type ReactNode } from "react"
import { Gauge, Inbox, List, Map as MapIcon, PlugZap, Wallet, Zap } from "lucide-react"
import { Mascot, MascotFace } from "@/components/brand/Mascot"
import { Logo } from "@/components/brand/Logo"
import { LoadingScreen } from "@/components/feedback/LoadingScreen"
import { NotFound } from "@/components/feedback/NotFound"
import { RouteErrorView } from "@/components/feedback/RouteErrorView"
import { PageHeader } from "@/components/painel/PageHeader"
import { Badge } from "@/components/ui/Badge"
import { Button } from "@/components/ui/Button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/Card"
import { EmptyState } from "@/components/ui/EmptyState"
import { ErrorState } from "@/components/ui/ErrorState"
import { IconBadge } from "@/components/ui/IconBadge"
import { Input } from "@/components/ui/Input"
import { Segmented } from "@/components/ui/Segmented"
import { Select } from "@/components/ui/Select"
import { Textarea } from "@/components/ui/Textarea"
import { Skeleton } from "@/components/ui/Skeleton"
import { StatCard } from "@/components/ui/StatCard"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/Table"
import { formatCents } from "@/lib/utils"

/**
 * Catálogo do design system — SÓ EM DEV (`/__ds`, ver App.tsx: a rota e este módulo saem do build de produção; `tailwind.config.js` também
 * tira `src/dev/` do conteúdo escaneado no build). Uma tela única para a Íris e para a Lyra compararem componentes a cada fase, nos dois fundos.
 * Não é página do produto: sem `aria-label` de teste, sem texto que E2E procure.
 */

function Section({ title, children, note }: { title: string; children: ReactNode; note?: string }) {
  return (
    <section className="space-y-3" aria-label={title}>
      <div>
        <h2 className="text-lg font-extrabold tracking-tight text-ink">{title}</h2>
        {note && <p className="mt-0.5 text-sm text-ink-softer">{note}</p>}
      </div>
      {children}
    </section>
  )
}

function Row({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <div className={`flex flex-wrap items-center gap-3 ${className}`}>{children}</div>
}

/** Razão de contraste WCAG entre dois "R G B" opacos. */
function ratio(a: [number, number, number], b: [number, number, number]) {
  const lum = ([r, g, bl]: [number, number, number]) => {
    const f = (c: number) => ((c /= 255) <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(bl)
  }
  const [hi, lo] = lum(a) > lum(b) ? [lum(a), lum(b)] : [lum(b), lum(a)]
  return (hi + 0.05) / (lo + 0.05)
}

const PAIRS: Array<{ name: string; fg: [number, number, number]; bg: [number, number, number]; min: number; forbidden?: boolean }> = [
  { name: "ink-softer #5F6673 / branco", fg: [95, 102, 115], bg: [255, 255, 255], min: 4.5 },
  { name: "ink-softer / muted #F3F4F6", fg: [95, 102, 115], bg: [243, 244, 246], min: 4.5 },
  { name: "ink-softer / tinta #E4ECF0", fg: [95, 102, 115], bg: [228, 236, 240], min: 4.5 },
  { name: "ink-subtle #9CA3AF / branco (só ícone decorativo aria-hidden: isento; NUNCA texto)", fg: [156, 163, 175], bg: [255, 255, 255], min: 1, forbidden: false },
  { name: "on-lime (noite) / lima", fg: [6, 22, 33], bg: [97, 219, 36], min: 4.5 },
  { name: "lima / noite (foco e ativo)", fg: [97, 219, 36], bg: [6, 22, 33], min: 3 },
  { name: "branco / primary-950 (sidebar)", fg: [255, 255, 255], bg: [14, 42, 58], min: 4.5 },
  { name: "white/60 sobre primary-950 (grupo da sidebar)", fg: [159, 170, 176], bg: [14, 42, 58], min: 4.5 },
  { name: "white/70 sobre cartão do rodapé (papel)", fg: [190, 197, 202], bg: [38, 63, 78], min: 4.5 },
  { name: "ink-softer escuro #BAC9D3 / surface escura #112E3F", fg: [186, 201, 211], bg: [17, 46, 63], min: 4.5 },
  { name: "ink-subtle escuro #8CA5B4 / surface escura", fg: [140, 165, 180], bg: [17, 46, 63], min: 3 },
  { name: "lima SOBRE BRANCO (proibido como texto)", fg: [97, 219, 36], bg: [255, 255, 255], min: 4.5, forbidden: true },
]

/** Liga/desliga o escopo do PWA (`html[data-area="driver"]`) só neste catálogo, para comparar campos, véu e cards dos dois escopos. */
function ScopeToggle() {
  const [on, setOn] = useState(false)
  useEffect(() => {
    if (on) document.documentElement.dataset.area = "driver"
    else delete document.documentElement.dataset.area
    return () => {
      delete document.documentElement.dataset.area
    }
  }, [on])
  return (
    <label className="inline-flex min-h-11 items-center gap-2 text-sm font-semibold text-ink">
      <input type="checkbox" checked={on} onChange={(e) => setOn(e.target.checked)} />
      Escopo do PWA (data-area="driver")
    </label>
  )
}

export default function DesignSystemCatalog() {
  const [hero, setHero] = useState(true)
  const [seg, setSeg] = useState<"list" | "map">("list")
  return (
    <div className="min-h-screen bg-background">
      <div className="surface-dark px-4 py-6 sm:px-8">
        <Logo tone="dark" />
        <h1 className="mt-4 text-3xl font-extrabold tracking-tight text-white">Design system InnoFlow</h1>
        <p className="mt-1 text-sm text-ink-softer">Catálogo interno (só dev). Moldura escura, miolo claro; lima = ação.</p>
      </div>

      <main className="mx-auto max-w-6xl space-y-12 px-4 py-10 sm:px-8">
        <Section title="Tokens" note="Semânticos novos da F-A sobre a paleta existente.">
          <Row>
            {[
              ["night", "bg-night"],
              ["primary-950", "bg-primary-950"],
              ["primary", "bg-primary"],
              ["lime", "bg-lime"],
              ["accent-600", "bg-accent-600"],
              ["warning-600", "bg-warning-600"],
              ["danger", "bg-danger"],
              ["muted", "bg-muted"],
              ["background", "bg-background border border-border"],
            ].map(([name, cls]) => (
              <div key={name} className="w-28 text-center">
                <div className={`h-14 rounded-control ${cls}`} />
                <p className="mt-1 text-xs font-semibold text-ink-soft">{name}</p>
              </div>
            ))}
          </Row>
        </Section>

        <Section title="Contraste das combinações (WCAG)" note="Calculado ao vivo. 'Proibido' mostra o que NÃO se faz.">
          <div className="overflow-hidden rounded-card border border-border">
            <table className="w-full text-sm">
              <tbody>
                {PAIRS.map((p) => {
                  const r = ratio(p.fg, p.bg)
                  const ok = r >= p.min
                  return (
                    <tr key={p.name} className="border-b border-border-subtle last:border-0">
                      <td className="px-3 py-2 text-ink-soft">{p.name}</td>
                      <td className="px-3 py-2 tabular-nums font-semibold text-ink">{r.toFixed(2)}:1</td>
                      <td className="px-3 py-2 text-ink-softer">mín. {p.min}:1</td>
                      <td className="px-3 py-2"><Badge variant={p.forbidden ? "warning" : ok ? "success" : "danger"}>{p.forbidden ? "proibido" : ok ? "passa" : "não passa"}</Badge></td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </Section>

        <Section title="Botões" note="lime = CTA único da tela; primary = salvar/confirmar em formulário e diálogo; glass = secundário sobre escuro.">
          <Row>
            <Button variant="lime" size="lg">Ação principal</Button>
            <Button variant="lime">Lima md</Button>
            <Button variant="lime" size="sm">Lima sm</Button>
            <Button variant="primary">Salvar</Button>
            <Button>Default (legado)</Button>
            <Button variant="outline">Outline</Button>
            <Button variant="ghost">Ghost</Button>
            <Button variant="destructive">Remover</Button>
            <Button variant="accent">Accent</Button>
            <Button variant="link">Link</Button>
            <Button variant="primary" loading>Salvando</Button>
            <Button variant="primary" disabled>Desabilitado</Button>
          </Row>
          <div className="surface-dark rounded-feature p-5">
            <Row>
              <Button variant="lime" size="lg">Ação principal</Button>
              <Button variant="glass" size="lg">Secundário (vidro)</Button>
              <Button variant="ghost">Ghost no escuro</Button>
              <Input aria-label="Campo no escuro" placeholder="Input dentro de .surface-dark" className="max-w-xs" />
            </Row>
          </div>
        </Section>

        <Section title="Cards" note="surface (padrão) · inverse (momento de marca, no máximo 1 por tela) · glass (só no escuro) · outline (drop zone).">
          <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
            <Card>
              <CardHeader><CardTitle>Surface</CardTitle><CardDescription>Card claro padrão.</CardDescription></CardHeader>
              <CardContent className="text-sm text-ink-soft">Miolo de leitura.</CardContent>
            </Card>
            <Card variant="inverse">
              <CardHeader><CardTitle>Inverse</CardTitle><CardDescription>Momento de marca.</CardDescription></CardHeader>
              <CardContent className="text-3xl font-extrabold tabular-nums text-white">{formatCents(4500)}</CardContent>
            </Card>
            <div className="surface-dark rounded-feature p-4">
              <Card variant="glass" className="p-4">
                <p className="font-bold text-white">Glass</p>
                <p className="text-sm text-ink-softer">Vidro sobre escuro.</p>
              </Card>
            </div>
            <Card variant="outline" className="p-5 text-sm text-ink-softer">Outline: solte o arquivo aqui.</Card>
          </div>
        </Section>

        <Section title="Badges e selos de ícone">
          <Row>
            <Badge>neutral</Badge><Badge variant="primary">primary</Badge><Badge variant="success">success</Badge><Badge variant="warning">warning</Badge>
            <Badge variant="danger">danger</Badge><Badge variant="info">info</Badge><Badge variant="lime">ao vivo</Badge>
            <span className="surface-dark inline-flex rounded-full p-1.5"><Badge variant="onDark">on dark</Badge></span>
          </Row>
          <Row>
            <IconBadge icon={Zap} size="sm" /><IconBadge icon={Wallet} size="md" tinted /><IconBadge icon={Gauge} size="lg" tinted /><IconBadge icon={Inbox} size="xl" tone="muted" />
            <span className="surface-dark flex gap-3 rounded-feature p-3"><IconBadge icon={Zap} size="lg" tone="lime" /><IconBadge icon={PlugZap} size="lg" tone="onDark" /></span>
          </Row>
        </Section>

        <Section title="PageHeader e StatCard" note="O hero é único por tela; sem contagem animada.">
          <PageHeader title="Título da tela" description="Descrição curta da área." icon={Gauge} eyebrow="Financeiro" actions={<Button variant="lime">Nova ação</Button>} animate={false} />
          <Row className="items-start">
            <label className="flex items-center gap-2 text-sm text-ink-soft">
              <input type="checkbox" checked={hero} onChange={(e) => setHero(e.target.checked)} /> hero
            </label>
          </Row>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <StatCard label="Faturamento" value={128450} deltaPct={12.4} icon={Wallet} formatValue={formatCents} variant={hero ? "hero" : "default"} />
            <StatCard label="Sessões" value={312} deltaPct={-3.1} icon={Zap} />
            <StatCard label="Novos" value={7} deltaPct={null} />
            <StatCard label="Sem movimento" value={0} deltaPct={null} />
          </div>
        </Section>

        <Section title="Tabela" note="comfortable (cadastros) e compact (listas longas, ~44 px por linha).">
          {(["comfortable", "compact"] as const).map((density) => (
            <Table key={density} density={density}>
              <TableHeader>
                <TableRow><TableHead>{density}</TableHead><TableHead>Status</TableHead><TableHead className="text-right">Valor</TableHead></TableRow>
              </TableHeader>
              <TableBody>
                {[1, 2, 3].map((n) => (
                  <TableRow key={n}><TableCell className="font-semibold text-ink">Linha {n}</TableCell><TableCell><Badge variant="success">ativo</Badge></TableCell><TableCell className="text-right tabular-nums">{formatCents(n * 1990)}</TableCell></TableRow>
                ))}
              </TableBody>
            </Table>
          ))}
        </Section>

        <Section title="Estados vazios" note="outline = legado · quiet = admin/filtro · brand = primeiro uso no app (mascote 64 px).">
          <div className="grid gap-4 md:grid-cols-3">
            <EmptyState icon={Inbox} title="Outline (legado)" description="Caixa tracejada." />
            <EmptyState tone="quiet" icon={Inbox} title="Quiet" description="Sem tracejado, selo tingido." action={<Button variant="primary" size="sm">Criar</Button>} />
            <EmptyState tone="brand" title="Brand" description="Ainda não há recarga por aqui." art={<MascotFace size={64} />} action={<Button variant="lime">Ver eletropostos</Button>} />
          </div>
        </Section>

        <Section
          title="Campos, véu e Segmented — escopo de área"
          note="Input/Select/Textarea/Button usam --field-radius (12 px por padrão; 14 px com data-area='driver'). O interruptor abaixo liga o escopo do PWA no <html> para comparar."
        >
          <ScopeToggle />
          <div className="grid gap-4 md:grid-cols-3">
            <Input label="Input" placeholder="Digite" />
            <Select label="Select" options={[{ value: "a", label: "Opção A" }]} />
            <Textarea label="Textarea" placeholder="Texto longo" />
          </div>
          <Row>
            <Segmented label="Exemplo claro" value={seg} onChange={setSeg} options={[{ value: "list", label: "Lista", icon: List }, { value: "map", label: "Mapa", icon: MapIcon }]} />
            <div className="surface-dark rounded-feature p-3">
              <Segmented label="Exemplo escuro" value={seg} onChange={setSeg} options={[{ value: "list", label: "Lista", icon: List }, { value: "map", label: "Mapa", icon: MapIcon }]} />
            </div>
          </Row>
        </Section>

        <Section title="ErrorState e LoadingScreen" note="inline (caixa vermelha, admin) · marca (art) · page (a tela inteira falhou) · LoadingScreen inline com e sem arte.">
          <div className="grid gap-4 md:grid-cols-2">
            <ErrorState message="Erro inline (admin)." onRetry={() => undefined} className="py-8" />
            <ErrorState art={<MascotFace size={64} />} message="Erro de marca (PWA/público)." onRetry={() => undefined} />
          </div>
          <ErrorState tone="page" art={<MascotFace size={64} />} message="Erro de tela inteira." onRetry={() => undefined} className="min-h-[40svh]" />
          <div className="grid gap-4 md:grid-cols-2">
            <LoadingScreen variant="inline" className="mx-0 min-h-[30svh]" />
            <LoadingScreen variant="inline" className="mx-0 min-h-[30svh]" art={<MascotFace size={48} />} artDelayMs={0} />
          </div>
        </Section>

        <Section title="Skeleton">
          <Row><Skeleton className="h-10 w-48" /><Skeleton className="h-10 w-32" /></Row>
          <div className="surface-dark rounded-feature p-4"><Skeleton className="h-10 w-56" /></div>
        </Section>

        <Section title="Marca">
          <div className="surface-dark surface-dark-rich relative overflow-hidden rounded-feature p-6">
            <div className="relative z-10 flex flex-wrap items-end gap-8">
              <div className="relative"><div className="brand-backlight" aria-hidden="true" /><Mascot sizes="200px" className="[--m-h:240px]" /></div>
              <div className="space-y-3">
                <p className="eyebrow text-lime">Eyebrow</p>
                <p className="glass-strong inline-block rounded-2xl px-4 py-3 font-extrabold text-white">Chip de vidro</p>
                <div><Logo tone="dark" /></div>
              </div>
            </div>
          </div>
        </Section>

        <Section title="404 e erro de tela inteira" note="Versões compactas; as de tela cheia usam min-h-screen.">
          <NotFound compact />
          <RouteErrorView compact error={new Error("Exemplo de erro (só aparece em dev)")} />
        </Section>
      </main>
    </div>
  )
}
