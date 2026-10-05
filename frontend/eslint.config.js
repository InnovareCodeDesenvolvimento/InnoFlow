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
    // Documento ISOLADO do cadastro de cartão (F5.3, SAQ A-EP — ver `.claude/agent-memory/nova/decisoes-f5-pagamento-cielo.md` §2). Guarda por ALLOWLIST (I-3 do Órion,
    // docs/AUDITORIA-PAGINA-CARTAO.md): a versão anterior era uma LISTA NEGRA de pastas do app e de 4 libs, e deixava passar `../hooks/...`, `zod`, `zustand`,
    // `localStorage`. Agora, em `src/pagamento-cartao/**` (fora os testes):
    //   - o ÚNICO pacote de terceiros importável é `react` e `react-dom/client`;
    //   - só entram módulos locais (`./x`), TIPOS (`@/types/**`) e imagens (`@/assets/**`); qualquer `../*` e qualquer outro `@/*` é erro;
    //   - nenhum armazenamento do navegador (`localStorage`, `sessionStorage`, `document.cookie`): esta página vê PAN/CVV e não deve gravar NADA.
    files: ['src/pagamento-cartao/**/*.{ts,tsx}'],
    ignores: ['src/pagamento-cartao/**/*.test.{ts,tsx}'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            { group: ['../*', '../**'], message: 'pagamento-cartao.html é um documento ISOLADO (SAQ A-EP): só módulos locais (./x), @/types/** e @/assets/**. Nada de subir pastas.' },
            {
              regex: '^@/(?!types/|assets/)',
              message: 'pagamento-cartao.html é um documento ISOLADO (SAQ A-EP): do app principal só entram TIPOS (@/types/**) e IMAGENS (@/assets/**). Ver decisoes-f5-pagamento-cielo.md §2.',
            },
            {
              // allowlist de pacotes: tudo que NÃO começa por `.`, `@/` e não é `react`/`react-dom/client` é barrado (axios, zod, zustand, react-router-dom, sonner, tanstack, radix, lucide...).
              regex: '^(?!react$|react-dom/client$|\\.|@/types/|@/assets/).+',
              message: 'pagamento-cartao.html é um documento ISOLADO (SAQ A-EP): o único pacote permitido é `react` (e `react-dom/client` no main.tsx). Cada dependência a mais é superfície para o Órion auditar.',
            },
          ],
        },
      ],
      'no-restricted-globals': [
        'error',
        { name: 'localStorage', message: 'A página do cartão vê PAN/CVV: não grava NADA no navegador (SAQ A-EP).' },
        { name: 'sessionStorage', message: 'A página do cartão vê PAN/CVV: não grava NADA no navegador (SAQ A-EP).' },
        { name: 'indexedDB', message: 'A página do cartão vê PAN/CVV: não grava NADA no navegador (SAQ A-EP).' },
      ],
      'no-restricted-syntax': [
        'error',
        { selector: "MemberExpression[property.name='cookie']", message: 'A página do cartão não lê nem grava cookie (SAQ A-EP).' },
        { selector: "MemberExpression[property.name=/^(localStorage|sessionStorage|indexedDB)$/]", message: 'A página do cartão não usa armazenamento do navegador, nem via window.* (SAQ A-EP).' },
      ],
    },
  },
])
