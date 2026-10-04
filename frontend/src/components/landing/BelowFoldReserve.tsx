import { SLOT_KEYS, slotClass } from "./landing-slots"

/**
 * Espaços vazios com a altura final das seções abaixo da dobra. É o que a casca da landing mostra ANTES de o conteúdo
 * ser montado (e enquanto o chunk dele carrega): o documento já tem o tamanho definitivo, então a barra de rolagem não
 * muda e nada é empurrado quando as seções entram. Sem fundo próprio: o fundo branco da página aparece como "vão" curto
 * se alguém rolar mais rápido do que a montagem.
 */
export function BelowFoldReserve() {
  return (
    <>
      {SLOT_KEYS.map((key) => (
        <div key={key} className={slotClass(key)} aria-hidden="true" />
      ))}
    </>
  )
}
