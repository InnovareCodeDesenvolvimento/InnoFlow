// @ts-check
/**
 * Lint do backend do InnoElektron. Conjunto enxuto (mesmo espírito do
 * ParquedasFeiras): pega defeito real (variável não usada, `any` solto) sem
 * exigir configuração type-aware (mais lenta, pediria project references).
 */
import js from '@eslint/js'
import tseslint from 'typescript-eslint'

export default tseslint.config(
  {
    ignores: ['dist/**', 'node_modules/**', 'prisma/generated/**'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      globals: {
        process: 'readonly',
        console: 'readonly',
        Buffer: 'readonly',
        __dirname: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly',
        fetch: 'readonly',
        AbortSignal: 'readonly',
        URL: 'readonly',
      },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' },
      ],
      // Dívida esperada no início do projeto (payloads OCPP/webhook ainda sem
      // schema Zod definitivo). Aviso, não erro — ver docs/ENGENHARIA.md
      // quando esse arquivo existir.
      '@typescript-eslint/no-explicit-any': 'warn',
    },
  },
  {
    // `src/core/` é domínio puro (sessão, tarifação, pagamentos, carteira) —
    // PROIBIDO importar transporte (express, ws, ocpp-rpc). Regra da Nova
    // (arquitetura): o núcleo de negócio não pode depender de como ele é
    // exposto (HTTP, WebSocket, fila), só assim ele fica testável isolado e
    // reaproveitável entre api/ocpp/worker.
    files: ['src/core/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            { name: 'express', message: 'core/ é domínio puro — proibido importar express (ver docs da Nova).' },
            { name: 'ws', message: 'core/ é domínio puro — proibido importar ws (ver docs da Nova).' },
            { name: 'ocpp-rpc', message: 'core/ é domínio puro — proibido importar ocpp-rpc (ver docs da Nova).' },
          ],
        },
      ],
    },
  }
)
