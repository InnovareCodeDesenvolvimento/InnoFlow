import type { ComponentProps } from "react"
import { MascotFace } from "@/components/brand/Mascot"
import { EmptyState } from "@/components/ui/EmptyState"
import { ErrorState } from "@/components/ui/ErrorState"

/**
 * Estados de erro e de PRIMEIRO USO do painel, com o mascote (D3 do dono: presença nos carregamentos, vazios e erros; NUNCA sobre dados — tabela, KPI,
 * gráfico — nem em vazio por filtro/busca, que continua `EmptyState` comum). `ui-kit` não pode importar o mascote (`ErrorState`/`EmptyState` recebem a arte por slot);
 * estes dois wrappers são a ponte, para as 14 telas não repetirem o import.
 */
export function AdminErrorState(props: Omit<ComponentProps<typeof ErrorState>, "art" | "tone">) {
  return <ErrorState {...props} art={<MascotFace size={56} />} />
}

/** Vazio de primeiro uso ("Nenhum site cadastrado"): card de marca com o mascote e a ação de criar. Para vazio por filtro use `EmptyState` (quiet). */
export function AdminFirstUseState(props: Omit<ComponentProps<typeof EmptyState>, "art" | "tone">) {
  return <EmptyState {...props} tone="brand" art={<MascotFace size={64} />} />
}
