/**
 * Seed mínimo do InnoElektron — 1 operador, 1 site, 1 charge point com 2
 * conectores (um deles DC CCS2, a instalação real de lançamento), 1 tariff
 * com idle fee, 1 motorista de teste. Mais dois usuários baratos (ADMIN da
 * plataforma e um OPERATOR de staff) só para exercitar o CHECK
 * `user_operator_role_consistency` na primeira carga — não pedido
 * explicitamente, mas custa quase nada e prova que a constraint funciona.
 *
 * Idempotente: roda com `upsert` em tudo que tem chave natural, então dá
 * pra rodar `npm run db:seed` várias vezes sem duplicar.
 *
 * basicAuthSecretHash/passwordHash usam bcrypt de verdade (Fase 3, Vega) —
 * o mesmo esquema que `ocpp/server.ts` (Basic Auth do gateway) e
 * `api/routes/auth.routes.ts` (login) usam para comparar.
 *
 * CREDENCIAIS (Órion C1, 2026-09-19): em PRODUÇÃO (`NODE_ENV=production`) o seed NUNCA usa
 * senha padrão. Cada credencial vem de uma env — `SEED_ADMIN_PASSWORD`,
 * `SEED_STAFF_PASSWORD`, `SEED_DRIVER_PASSWORD` (>= 12 caracteres) e
 * `SEED_CHARGEPOINT_SECRET` (16 a 40) — e se faltar, o seed PULA a criação daquele usuário/
 * carregador com um aviso claro (nunca cai no `admin123456`). Fora de produção mantém defaults
 * de dev, impressos no console. Valores fornecidos por env NUNCA são impressos. `upsert` com
 * `update: {}`: rodar de novo não troca a senha de uma conta que já existe (para rotacionar
 * use `npm run user:set-password`).
 */
import { PrismaClient } from '@prisma/client'
import bcrypt from 'bcryptjs'
import { resolveSeedSecret, type SeedSecretResult } from './seedSecrets'

const prisma = new PrismaClient()

// 12 rounds (Órion: 10 é o piso) — alinhado com `auth.routes.ts`.
const BCRYPT_ROUNDS = 12
const IS_PRODUCTION = process.env.NODE_ENV === 'production'

async function hash(secret: string): Promise<string> {
  return bcrypt.hash(secret, BCRYPT_ROUNDS)
}

function reportSkipped(what: string, secret: SeedSecretResult): void {
  if (secret.status === 'skipped') console.warn(`[seed] AVISO: ${what} NÃO foi criado — ${secret.reason}.`)
}

async function main() {
  if (IS_PRODUCTION) console.log('[seed] NODE_ENV=production: credenciais só por env (SEED_*), nunca padrão.')

  const operator = await prisma.operator.upsert({
    where: { cnpj: '12345678000199' },
    update: {},
    create: {
      name: 'InnoElektron Operações',
      legalName: 'InnoElektron Operações de Recarga Ltda.',
      cnpj: '12345678000199',
      email: 'operacoes@innoelektron.example.com',
      phone: '+55 11 90000-0000',
    },
  })

  // Site não tem chave natural única no schema (só `id`) — em vez de fixar
  // um id legível (`seed-site-matriz`, rejeitado por `.cuid()` em qualquer
  // formulário que referencie este registro, bug já registrado em memória),
  // buscamos por `operatorId`+`name` e deixamos o Postgres gerar o cuid real
  // via `@default(cuid())` do schema, omitindo `id` no create. Resultado:
  // dado de seed idêntico em FORMATO a um registro de produção real.
  const SITE_MATRIZ_NAME = 'InnoElektron — Estação Matriz'
  const site =
    (await prisma.site.findFirst({ where: { operatorId: operator.id, name: SITE_MATRIZ_NAME } })) ??
    (await prisma.site.create({
      data: {
        operatorId: operator.id,
        name: SITE_MATRIZ_NAME,
        addressLine: 'Av. Paulista, 1000',
        city: 'São Paulo',
        state: 'SP',
        postalCode: '01310-100',
        country: 'BR',
        latitude: '-23.561684',
        longitude: '-46.655981',
        timezone: 'America/Sao_Paulo',
        openingHours: { seg_sex: '00:00-23:59', sab_dom: '00:00-23:59' },
      },
    }))

  // Carregador do seed (Basic Auth do gateway OCPP): o segredo também é uma credencial — em
  // produção só por env (`SEED_CHARGEPOINT_SECRET`, 16 a 40 caracteres); sem ela o carregador do
  // seed (e seus conectores/vínculo de tarifa) simplesmente não é criado.
  const chargePointSecret = resolveSeedSecret({ envName: 'SEED_CHARGEPOINT_SECRET', devDefault: 'changeme-basic-auth-secret', minLength: 16, maxLength: 40 }, process.env, IS_PRODUCTION)
  reportSkipped('o carregador do seed (CP-INNOELEKTRON-001)', chargePointSecret)

  // ChargePoint.operatorId é desnormalizado por trigger — não precisa (e não
  // deve) ser setado aqui; o valor abaixo seria sobrescrito pelo Postgres de
  // qualquer forma.
  const chargePoint =
    chargePointSecret.status === 'ok'
      ? await prisma.chargePoint.upsert({
          where: { ocppIdentity: 'CP-INNOELEKTRON-001' },
          update: {},
          create: {
            siteId: site.id,
            operatorId: operator.id,
            ocppIdentity: 'CP-INNOELEKTRON-001',
            vendor: 'ABB',
            model: 'Terra 184',
            serialNumber: 'SN-SEED-0001',
            firmwareVersion: '1.0.0-seed',
            basicAuthSecretHash: await hash(chargePointSecret.value),
            configSnapshot: { seed: true },
          },
        })
      : null

  // connectorId = 1 -> DC CCS2 (carga rápida, instalação real de lançamento).
  const connectorCcs2 = chargePoint
    ? await prisma.connector.upsert({
        where: { chargePointId_connectorId: { chargePointId: chargePoint.id, connectorId: 1 } },
        update: {},
        create: {
          chargePointId: chargePoint.id,
          operatorId: operator.id,
          connectorId: 1,
          type: 'DC_CCS2',
          maxPowerKw: '60.00',
          status: 'AVAILABLE',
        },
      })
    : null

  // connectorId = 2 -> AC Tipo 2 (carga lenta/complementar).
  if (chargePoint) {
    await prisma.connector.upsert({
      where: { chargePointId_connectorId: { chargePointId: chargePoint.id, connectorId: 2 } },
      update: {},
      create: {
        chargePointId: chargePoint.id,
        operatorId: operator.id,
        connectorId: 2,
        type: 'AC_TYPE2',
        maxPowerKw: '22.00',
        status: 'AVAILABLE',
      },
    })
  }

  // Tariff com idle fee — R$0,7912/kWh, R$1,00/min de ociosidade após 10min
  // de carência, mínimo de R$5,00 por sessão. Mesmo raciocínio do site acima:
  // sem chave natural única, busca por `operatorId`+`name` em vez de um id
  // legível fixo.
  const TARIFF_PADRAO_NAME = 'Padrão CCS2'
  const tariff =
    (await prisma.tariff.findFirst({ where: { operatorId: operator.id, name: TARIFF_PADRAO_NAME } })) ??
    (await prisma.tariff.create({
      data: {
        operatorId: operator.id,
        name: TARIFF_PADRAO_NAME,
        model: 'PER_KWH',
        pricePerKwh: '0.7912',
        minChargeCents: 500,
        idleFeePerMinute: 100, // R$1,00/min
        idleGracePeriodSeconds: 600, // 10 minutos de carência
        currency: 'BRL',
      },
    }))

  // TariffAssignment também sem chave natural — idempotência aqui é "já
  // existe um vínculo CHARGE_POINT ativo desta tarifa para este charge
  // point?", não um id fixo.
  const hasTariffAssignment = chargePoint
    ? await prisma.tariffAssignment.findFirst({ where: { tariffId: tariff.id, chargePointId: chargePoint.id, scope: 'CHARGE_POINT' } })
    : null
  if (chargePoint && !hasTariffAssignment) {
    await prisma.tariffAssignment.create({
      data: {
        tariffId: tariff.id,
        operatorId: operator.id,
        scope: 'CHARGE_POINT',
        chargePointId: chargePoint.id,
        priority: 0,
        validFrom: new Date('2026-01-01T00:00:00Z'),
      },
    })
  }

  // --- Usuários ---
  // Cada um só é criado se a credencial resolver (env em produção; env ou default de dev fora
  // dela) — ver `seedSecrets.ts`. O motorista arrasta consigo AuthToken/Wallet/crédito inicial.

  const adminPassword = resolveSeedSecret({ envName: 'SEED_ADMIN_PASSWORD', devDefault: 'admin123456', minLength: 12 }, process.env, IS_PRODUCTION)
  const staffPassword = resolveSeedSecret({ envName: 'SEED_STAFF_PASSWORD', devDefault: 'staff123456', minLength: 12 }, process.env, IS_PRODUCTION)
  const driverPassword = resolveSeedSecret({ envName: 'SEED_DRIVER_PASSWORD', devDefault: 'driver123456', minLength: 12 }, process.env, IS_PRODUCTION)
  reportSkipped('o ADMIN do seed', adminPassword)
  reportSkipped('o OPERATOR de staff do seed', staffPassword)
  reportSkipped('o motorista de teste do seed', driverPassword)

  const admin =
    adminPassword.status === 'ok'
      ? await prisma.user.upsert({
          where: { email: 'admin@innoelektron.example.com' },
          update: {},
          create: {
            role: 'ADMIN',
            name: 'Admin da Plataforma',
            email: 'admin@innoelektron.example.com',
            passwordHash: await hash(adminPassword.value),
          },
        })
      : null

  const operatorStaff =
    staffPassword.status === 'ok'
      ? await prisma.user.upsert({
          where: { email: 'staff@innoelektron-operacoes.example.com' },
          update: {},
          create: {
            role: 'OPERATOR',
            operatorId: operator.id,
            name: 'Staff do Operador',
            email: 'staff@innoelektron-operacoes.example.com',
            passwordHash: await hash(staffPassword.value),
          },
        })
      : null

  const driver =
    driverPassword.status === 'ok'
      ? await prisma.user.upsert({
          where: { email: 'motorista.teste@innoelektron.example.com' },
          update: {},
          create: {
            role: 'DRIVER',
            name: 'Motorista de Teste',
            email: 'motorista.teste@innoelektron.example.com',
            phone: '+55 11 91234-5678',
            passwordHash: await hash(driverPassword.value),
          },
        })
      : null

  let wallet: { id: string } | null = null
  if (driver) {
    await prisma.authToken.upsert({
      where: { idTag: 'SEED-DRIVER-01' },
      update: {},
      create: {
        idTag: 'SEED-DRIVER-01',
        type: 'VIRTUAL',
        userId: driver.id,
        status: 'ACCEPTED',
      },
    })

    wallet = await prisma.wallet.upsert({
      where: { userId: driver.id },
      update: {},
      create: { userId: driver.id },
    })

    // Só cria a entrada de boas-vindas se a carteira ainda não tem nenhuma —
    // WalletEntry é append-only, então upsert por chave natural não existe;
    // checamos existência antes de inserir para manter o seed idempotente.
    const hasEntries = await prisma.walletEntry.findFirst({ where: { walletId: wallet.id } })
    if (!hasEntries) {
      await prisma.walletEntry.create({
        data: {
          walletId: wallet.id,
          type: 'TOPUP_PIX',
          amountCents: 5000, // R$ 50,00 de saldo inicial de teste
          balanceAfterCents: 5000,
          referenceType: 'SEED',
          description: 'Crédito inicial de teste (seed)',
        },
      })
    }
  }

  console.log('[seed] operador:', operator.name)
  console.log('[seed] site:', site.name)
  if (chargePoint) console.log('[seed] charge point:', chargePoint.ocppIdentity, '— conectores: CCS2 #1, AC Tipo 2 #2')
  if (connectorCcs2) console.log('[seed] connector CCS2 id interno:', connectorCcs2.id)
  console.log('[seed] tariff:', tariff.name, '— idle fee', tariff.idleFeePerMinute, 'centavos/min')
  const criados = [admin && `${admin.email} (ADMIN)`, operatorStaff && `${operatorStaff.email} (OPERATOR)`, driver && `${driver.email} (DRIVER)`].filter(Boolean)
  console.log('[seed] usuários criados/existentes:', criados.length > 0 ? criados.join(', ') : '(nenhum)')

  // Senha só é impressa quando é o DEFAULT de dev (público no repositório de qualquer forma) —
  // credencial vinda de env nunca vai para o log.
  const lines: string[] = []
  if (admin && adminPassword.status === 'ok' && adminPassword.source === 'dev-default') lines.push(`${admin.email} / ${adminPassword.value}`)
  if (operatorStaff && staffPassword.status === 'ok' && staffPassword.source === 'dev-default') lines.push(`${operatorStaff.email} / ${staffPassword.value}`)
  if (driver && driverPassword.status === 'ok' && driverPassword.source === 'dev-default') lines.push(`${driver.email} / ${driverPassword.value}`)
  if (lines.length > 0) {
    console.log('[seed] senhas de teste (dev only, NUNCA use em produção):')
    for (const line of lines) console.log(`[seed]   ${line}`)
  }
  if (chargePoint && chargePointSecret.status === 'ok' && chargePointSecret.source === 'dev-default') {
    console.log(`[seed] basic auth do charge point CP-INNOELEKTRON-001 (dev): ${chargePointSecret.value}`)
  }
  if (wallet) console.log('[seed] wallet do motorista:', wallet.id, '— saldo inicial R$ 50,00')
}

main()
  .catch((err) => {
    console.error(err)
    process.exit(1)
  })
  .finally(async () => {
    await prisma.$disconnect()
  })
