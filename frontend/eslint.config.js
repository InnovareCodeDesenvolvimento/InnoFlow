import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import tseslint from 'typescript-eslint'
import { defineConfig, globalIgnores } from 'eslint/config'

export default defineConfig([
  globalIgnores(['dist', 'public/mockServiceWorker.js']),
  {
    files: ['**/*.{ts,tsx}'],
    extends: [
      js.configs.recommended,
      tseslint.configs.recommended,
      reactHooks.configs.flat.recommended,
      reactRefresh.configs.vite,
    ],
    languageOptions: {
      ecmaVersion: 2020,
      globals: globals.browser,
    },
  },
  {
    // Documento ISOLADO do cadastro de cartão (F5.3, SAQ A-EP — ver
    // `.claude/agent-memory/nova/decisoes-f5-pagamento-cielo.md` §2). Regra
    // EXECUTÁVEL, não só convenção: nada daqui pode importar do app
    // principal (componentes/hooks/services/mocks/store/páginas/schemas/lib)
    // nem das libs que ele usa para falar com nossa API/rotas/cache — a
    // página isolada não fala com o backend em nome próprio, só recebe a
    // sessão de tokenização via postMessage e devolve o CardToken do mesmo
    // jeito. `@/types/**` continua permitido (só tipos + uma const string,
    // zero custo em runtime, ver `types/cardTokenizationChannel.ts`).
    files: ['src/pagamento-cartao/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: [
                '@/components/**',
                '@/hooks/**',
                '@/services/**',
                '@/mocks/**',
                '@/store/**',
                '@/pages/**',
                '@/schemas/**',
                '@/lib/**',
              ],
              message:
                'pagamento-cartao.html é um documento ISOLADO (SAQ A-EP) — não pode importar nada do app principal. Só @/types/** (tipos) e módulos locais de src/pagamento-cartao/. Ver decisoes-f5-pagamento-cielo.md §2.',
            },
          ],
          paths: [
            { name: 'axios', message: 'A página isolada não fala com nossa API em nome próprio — zero necessidade de axios aqui.' },
            { name: 'react-router-dom', message: 'Página isolada não tem rotas.' },
            { name: '@tanstack/react-query', message: 'Página isolada não precisa de cache/mutations do TanStack Query.' },
            { name: 'sonner', message: 'Página isolada usa os próprios estados de erro (`pc-alert`), não o toaster do app principal.' },
          ],
        },
      ],
    },
  },
])
