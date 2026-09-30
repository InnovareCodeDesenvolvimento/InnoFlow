import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    globals: false,
    include: ['tests/**/*.test.ts'],
    testTimeout: 20_000,
    hookTimeout: 30_000,
    env: {
      // F5.4 (2026-09-30) — chave de teste FIXA pra `PAYMENT_SECRETS_KEY`
      // (cifra/decifra de `PaymentMethod.cieloCardTokenCiphertext`). `env.ts`
      // lê `process.env` UMA VEZ, no import (ver bug-env-eager-todos-
      // entrypoints.md) — setar isto aqui (`test.env` do Vitest) garante que
      // já está presente ANTES do primeiro import de qualquer módulo que
      // puxe `env.ts`, o que um `process.env.X = ...` dentro de um arquivo de
      // teste NÃO garantiria (imports do próprio arquivo já rodaram antes).
      // NUNCA usar este valor fora de teste.
      PAYMENT_SECRETS_KEY: 'N9kxeAXn4BnqUUoF1v+dbfdbLGJLH0WPqIdGIqbbK28=',
    },
    coverage: {
      provider: 'v8',
      reportsDirectory: './coverage',
      include: ['src/**/*.ts'],
      exclude: ['src/entrypoints/**', 'src/**/*.d.ts'],
    },
  },
})
