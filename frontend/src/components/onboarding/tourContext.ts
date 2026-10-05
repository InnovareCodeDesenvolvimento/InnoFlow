import { createContext, useContext } from "react"
import type { TourId } from "./tourMeta"

export interface TourContextValue {
  /** `true` enquanto o tour está aberto (o menu do Admin usa isto para abrir todos os grupos, senão os itens-alvo ficariam recolhidos). */
  active: boolean
  /** Há um tour para este usuário nesta área? Fora dos shells (ou sem provider) é `false` e `restart` não faz nada. */
  available: boolean
  tourId: TourId | undefined
  /** "Rever tour": abre o tour do começo, sem mexer no registro até o usuário terminar ou pular de novo. */
  restart: () => void
}

const NOOP: TourContextValue = { active: false, available: false, tourId: undefined, restart: () => undefined }

export const TourContext = createContext<TourContextValue>(NOOP)

/** Acesso ao tour da área atual. Seguro fora de um provider (devolve um valor inerte), para peças compartilhadas como o checklist. */
export function useTour(): TourContextValue {
  return useContext(TourContext)
}
