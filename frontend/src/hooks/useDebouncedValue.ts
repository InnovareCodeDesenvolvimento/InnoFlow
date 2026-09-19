import { useEffect, useState } from "react"

/** Valor "assentado": só muda `delayMs` depois da última alteração — pra busca não disparar uma chamada por tecla. */
export function useDebouncedValue<T>(value: T, delayMs = 350): T {
  const [debounced, setDebounced] = useState(value)
  useEffect(() => {
    const id = setTimeout(() => setDebounced(value), delayMs)
    return () => clearTimeout(id)
  }, [value, delayMs])
  return debounced
}
