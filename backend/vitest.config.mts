import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    globals: false,
    include: ['tests/**/*.test.ts'],
    testTimeout: 20_000,
    hookTimeout: 30_000,
    env: {
      // MUDANÇA DELIBERADA (05/10/2026 — chave dos segredos DERIVADA do JWT_SECRET, como no InnoChat): a suíte NÃO define mais `PAYMENT_SECRETS_KEY` — o modo padrão é a chave derivada do
      // `JWT_SECRET`, e é ESSE modo que os testes de cartão/gateway/comunicação/backup exercitam. Quem testa o override (`PAYMENT_SECRETS_KEY`) ou a rotação define a variável no próprio teste.
      // `env.ts` lê `process.env` UMA VEZ, no import (ver bug-env-eager-todos-entrypoints.md) — setar aqui (`test.env` do Vitest) garante que já está presente ANTES do primeiro import de
      // qualquer módulo que puxe `env.ts`. O `JWT_SECRET` do ambiente (CI/shell) vale se tiver >= 32 caracteres; senão, este valor FIXO. NUNCA usar fora de teste.
      JWT_SECRET: (process.env.JWT_SECRET ?? '').length >= 32 ? (process.env.JWT_SECRET as string) : 'vitest-jwt-secret-fixo-para-testes-0123456789',
      // I-7: o contador de recusas de cartão POR IP (janela de 1 h, no Redis COMPARTILHADO entre as suítes paralelas e entre execuções) somaria as recusas de todos os testes, que enxergam o
      // mesmo IP (127.0.0.1) — bloquearia suítes inocentes. Nos testes o limite por IP é efetivamente desligado; os testes de bloqueio usam IPs próprios e sobrescrevem o limite no `env`.
      CARD_BLOCK_MAX_REFUSALS_PER_IP_HOUR: '1000000',
      // N-7: o notificador dos avisos ao dono leria a configuração do banco (NotificationChannelConfig) no 1º alerta de CADA suíte — nos testes só vale a env (quem testa o painel
      // liga de volta com `COMMUNICATION_DISABLE_DB_CONFIG=false` ANTES de importar o logger).
      COMMUNICATION_DISABLE_DB_CONFIG: 'true',
      // L1.9: versões VIGENTES dos termos fixas nos testes (os testes de cadastro/Google/reaceite mandam `acceptedTermsVersion` = esta). Valor próprio, diferente do default de produção, para um
      // teste nunca passar "por acaso" com a versão do default; `tests/integration/helpers/termos.ts` repete o valor.
      LEGAL_TERMS_VERSION: 'termos-teste-1',
      LEGAL_PRIVACY_VERSION: 'privacidade-teste-1',
    },
    coverage: {
      provider: 'v8',
      reportsDirectory: './coverage',
      include: ['src/**/*.ts'],
      exclude: ['src/entrypoints/**', 'src/**/*.d.ts'],
    },
  },
})
