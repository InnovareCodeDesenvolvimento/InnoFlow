/**
 * Shell mínimo — só para provar que o frontend builda e roda (Fase 0). As
 * telas reais (login, dashboard, fluxo de carga) são da Lyra, a partir dos
 * contratos Zod da API (Fase 2/3c do plano da Nova).
 */
export function HelloPage() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-2 bg-background text-center">
      <h1 className="text-2xl font-semibold text-primary">InnoElektron</h1>
      <p className="text-muted-foreground">Plataforma de eletropostos — frontend em construção.</p>
    </main>
  )
}
