/// <reference types="vite/client" />

// Injetadas em build-time por `buildDefine` (ver ../buildInfo.ts).
declare const __APP_VERSION__: string
declare const __BUILD_DATE__: string

interface ImportMetaEnv {
  /** Template de tiles do mapa (Leaflet: `{s}`/`{z}`/`{x}`/`{y}`/`{r}`). Default: OpenStreetMap (tile.openstreetmap.org). */
  readonly VITE_MAP_TILE_URL?: string
  /** Atribuição exibida no canto do mapa (obrigatória pelos provedores de tiles; aceita HTML). */
  readonly VITE_MAP_ATTRIBUTION?: string
}
