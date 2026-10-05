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
      // I-7: o contador de recusas de cartão POR IP (janela de 1 h, no Redis COMPARTILHADO entre as suítes paralelas e entre execuções) somaria as recusas de todos os testes, que enxergam o
      // mesmo IP (127.0.0.1) — bloquearia suítes inocentes. Nos testes o limite por IP é efetivamente desligado; os testes de bloqueio usam IPs próprios e sobrescrevem o limite no `env`.
      CARD_BLOCK_MAX_REFUSALS_PER_IP_HOUR: '1000000',
      // N-7: o notificador dos avisos ao dono leria a configuração do banco (NotificationChannelConfig) no 1º alerta de CADA suíte — nos testes só vale a env (quem testa o painel
      // liga de volta com `COMMUNICATION_DISABLE_DB_CONFIG=false` ANTES de importar o logger).
      COMMUNICATION_DISABLE_DB_CONFIG: 'true',
    },
    coverage: {
      provider: 'v8',
      reportsDirectory: './coverage',
      include: ['src/**/*.ts'],
      exclude: ['src/entrypoints/**', 'src/**/*.d.ts'],
    },
  },
})
