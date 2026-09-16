import { create } from "zustand"
import { persist } from "zustand/middleware"
import { authService, type LoginPayload, type RegisterPayload } from "@/services/auth"
import { TOKEN_STORAGE_KEY } from "@/services/api"
import type { User } from "@/types/api"

/**
 * Estado de autenticação — o único estado GLOBAL de verdade desta fase (é
 * compartilhado por header, guardas de rota e o painel admin; tudo o mais é
 * estado de servidor via TanStack Query ou estado local do componente).
 *
 * DECISÃO DE SEGURANÇA (documentada, pedida explicitamente no escopo):
 * o token JWT fica em `localStorage`, não em cookie httpOnly. O backend
 * desta fase (F3a/F3b) não emite cookie nenhum — só devolve `{ token, user }`
 * no corpo — então não há alternativa sem mudar o contrato da API. Isso
 * expõe o token a XSS; aceitável nesta fase (aplicação sem HTML de terceiros
 * renderizado, sem `dangerouslySetInnerHTML`), mas é uma dívida a revisitar
 * quando a Vega tiver tempo de emitir refresh token via cookie httpOnly
 * (mesmo padrão que o ParquedasFeiras já usa).
 */

interface AuthState {
  user: User | null
  token: string | null
  isAuthenticated: boolean
  isLoading: boolean
  login: (payload: LoginPayload) => Promise<User>
  register: (payload: RegisterPayload) => Promise<User>
  logout: () => void
}

export const useAuthStore = create<AuthState>()(
  persist(
    (set) => ({
      user: null,
      token: null,
      isAuthenticated: false,
      isLoading: false,

      login: async (payload) => {
        set({ isLoading: true })
        try {
          const { token, user } = await authService.login(payload)
          localStorage.setItem(TOKEN_STORAGE_KEY, token)
          set({ user, token, isAuthenticated: true, isLoading: false })
          return user
        } catch (err) {
          set({ isLoading: false })
          throw err
        }
      },

      register: async (payload) => {
        set({ isLoading: true })
        try {
          const { token, user } = await authService.register(payload)
          localStorage.setItem(TOKEN_STORAGE_KEY, token)
          set({ user, token, isAuthenticated: true, isLoading: false })
          return user
        } catch (err) {
          set({ isLoading: false })
          throw err
        }
      },

      logout: () => {
        localStorage.removeItem(TOKEN_STORAGE_KEY)
        set({ user: null, token: null, isAuthenticated: false })
      },
    }),
    {
      name: "innoelektron-auth",
      partialize: (s) => ({ user: s.user, token: s.token, isAuthenticated: s.isAuthenticated }),
    },
  ),
)
