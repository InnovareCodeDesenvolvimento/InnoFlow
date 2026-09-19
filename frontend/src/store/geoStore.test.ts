import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { GEO_OPTIONS, useGeoStore } from "./geoStore"

type SuccessCb = (pos: GeolocationPosition) => void
type ErrorCb = (err: GeolocationPositionError) => void

function mockGeolocation() {
  const getCurrentPosition = vi.fn<(ok: SuccessCb, err: ErrorCb, opts?: PositionOptions) => void>()
  Object.defineProperty(navigator, "geolocation", { configurable: true, value: { getCurrentPosition } })
  return getCurrentPosition
}

function mockPermission(state: PermissionState | "throw") {
  const query = vi.fn(async () => {
    if (state === "throw") throw new Error("Permissions API indisponível")
    return { state } as PermissionStatus
  })
  Object.defineProperty(navigator, "permissions", { configurable: true, value: { query } })
  return query
}

const fix = (lat: number, lng: number) => ({ coords: { latitude: lat, longitude: lng } }) as GeolocationPosition
const geoError = (code: number) => ({ code, message: "x" }) as GeolocationPositionError

describe("geoStore — estados da geolocalização", () => {
  beforeEach(() => {
    useGeoStore.getState().reset()
    localStorage.clear()
  })
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it("pede ao aparelho com as opções combinadas: 10 s, sem alta precisão, cache de 60 s", () => {
    const get = mockGeolocation()
    useGeoStore.getState().request()
    expect(useGeoStore.getState().status).toBe("requesting")
    expect(get).toHaveBeenCalledTimes(1)
    expect(get.mock.calls[0][2]).toEqual({ enableHighAccuracy: false, timeout: 10_000, maximumAge: 60_000 })
    expect(GEO_OPTIONS.timeout).toBe(10_000)
  })

  it("concedida: guarda a posição SÓ em memória", () => {
    const get = mockGeolocation()
    useGeoStore.getState().request()
    get.mock.calls[0][0](fix(-23.5614, -46.6559))
    expect(useGeoStore.getState()).toMatchObject({ status: "granted", position: { lat: -23.5614, lng: -46.6559 } })
    // Privacidade: nada de posição em localStorage/sessionStorage.
    expect(JSON.stringify({ ...localStorage })).not.toContain("-23.56")
    expect(JSON.stringify({ ...sessionStorage })).not.toContain("-23.56")
  })

  it("negada (código 1): status denied e esquece a posição antiga", () => {
    const get = mockGeolocation()
    useGeoStore.setState({ position: { lat: 1, lng: 2 }, status: "granted" })
    useGeoStore.getState().request()
    get.mock.calls[0][1](geoError(1))
    expect(useGeoStore.getState()).toMatchObject({ status: "denied", position: null })
  })

  it("timeout (código 3): status timeout, mantém a última posição conhecida", () => {
    const get = mockGeolocation()
    useGeoStore.setState({ position: { lat: 1, lng: 2 }, status: "granted" })
    useGeoStore.getState().request()
    get.mock.calls[0][1](geoError(3))
    expect(useGeoStore.getState()).toMatchObject({ status: "timeout", position: { lat: 1, lng: 2 } })
  })

  it("posição indisponível (código 2): status unavailable", () => {
    const get = mockGeolocation()
    useGeoStore.getState().request()
    get.mock.calls[0][1](geoError(2))
    expect(useGeoStore.getState().status).toBe("unavailable")
  })

  it("navegador sem geolocation: unavailable, sem exceção", () => {
    Object.defineProperty(navigator, "geolocation", { configurable: true, value: undefined })
    useGeoStore.getState().request()
    expect(useGeoStore.getState().status).toBe("unavailable")
  })
})

describe("geoStore — pedido automático só com permissão já concedida", () => {
  beforeEach(() => useGeoStore.getState().reset())

  it("granted: pede sozinho, sem prompt", async () => {
    const get = mockGeolocation()
    mockPermission("granted")
    await useGeoStore.getState().autoRequestIfGranted()
    expect(get).toHaveBeenCalledTimes(1)
  })

  it.each(["prompt", "denied"] as const)("%s: NÃO pede (nunca abre prompt do navegador sozinho)", async (state) => {
    const get = mockGeolocation()
    mockPermission(state)
    await useGeoStore.getState().autoRequestIfGranted()
    expect(get).not.toHaveBeenCalled()
    expect(useGeoStore.getState().status).toBe("idle")
  })

  it("Permissions API ausente/quebrada: não pede e não estoura", async () => {
    const get = mockGeolocation()
    mockPermission("throw")
    await expect(useGeoStore.getState().autoRequestIfGranted()).resolves.toBeUndefined()
    expect(get).not.toHaveBeenCalled()
  })

  it("só checa uma vez por sessão", async () => {
    mockGeolocation()
    const query = mockPermission("prompt")
    await useGeoStore.getState().autoRequestIfGranted()
    await useGeoStore.getState().autoRequestIfGranted()
    expect(query).toHaveBeenCalledTimes(1)
  })
})
