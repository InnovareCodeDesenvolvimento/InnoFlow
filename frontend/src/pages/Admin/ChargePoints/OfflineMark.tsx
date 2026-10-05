/**
 * Rótulo discreto "Offline" da célula Status da lista de carregadores (decisão do dono, 05/10/2026). Só aparece quando o SERVIDOR diz `online === false` (nunca recalculado aqui) E o
 * cadastro está ativo: um carregador inativo já está fora de operação por decisão do admin, "offline" ali seria ruído. Ponto + TEXTO (não depende só de cor) em tom de atenção, não de
 * erro: é um estado transitório do equipamento, não uma falha do cadastro. Tem de ser inline (sem coluna nova, sem aumentar a altura da linha).
 */
export function OfflineMark({ online, active }: { online: boolean; active: boolean }) {
  if (online || !active) return null
  return (
    <span
      className="inline-flex items-center gap-1.5 whitespace-nowrap text-xs font-semibold text-warning-700"
      data-testid="cp-offline"
      title="O carregador não está se comunicando com o sistema agora."
    >
      <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-warning-700" aria-hidden="true" />
      Offline
    </span>
  )
}
