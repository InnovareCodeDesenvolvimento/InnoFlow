/**
 * Nome antigo do `StatCard` (`components/ui/StatCard`, design system unificado F-A). Mantido para os imports do Dashboard, Financeiro e
 * Faturamento não mudarem de caminho de uma vez; a F-D troca os usos por `StatCard` (e `highlight` por `variant="hero"`) e apaga este arquivo.
 */
export { StatCard as MetricCard } from "@/components/ui/StatCard"
