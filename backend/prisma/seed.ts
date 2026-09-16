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
 * `api/routes/auth.routes.ts` (login) usam para comparar. Credenciais em
 * claro só aparecem no console deste seed (fixture de dev, nunca em prod).
 */
import { PrismaClient } from '@prisma/client'
import bcrypt from 'bcryptjs'

const prisma = new PrismaClient()

const BCRYPT_ROUNDS = 10

async function hash(secret: string): Promise<string> {
  return bcrypt.hash(secret, BCRYPT_ROUNDS)
}

async function main() {
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

  const site = await prisma.site.upsert({
    where: { id: 'seed-site-matriz' },
    update: {},
    create: {
      id: 'seed-site-matriz',
      operatorId: operator.id,
      name: 'InnoElektron — Estação Matriz',
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
  })

  // ChargePoint.operatorId é desnormalizado por trigger — não precisa (e não
  // deve) ser setado aqui; o valor abaixo seria sobrescrito pelo Postgres de
  // qualquer forma.
  const chargePoint = await prisma.chargePoint.upsert({
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
      basicAuthSecretHash: await hash('changeme-basic-auth-secret'),
      configSnapshot: { seed: true },
    },
  })

  // connectorId = 1 -> DC CCS2 (carga rápida, instalação real de lançamento).
  const connectorCcs2 = await prisma.connector.upsert({
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

  // connectorId = 2 -> AC Tipo 2 (carga lenta/complementar).
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

  // Tariff com idle fee — R$0,7912/kWh, R$1,00/min de ociosidade após 10min
  // de carência, mínimo de R$5,00 por sessão.
  const tariff = await prisma.tariff.upsert({
    where: { id: 'seed-tariff-padrao' },
    update: {},
    create: {
      id: 'seed-tariff-padrao',
      operatorId: operator.id,
      name: 'Padrão CCS2',
      model: 'PER_KWH',
      pricePerKwh: '0.7912',
      minChargeCents: 500,
      idleFeePerMinute: 100, // R$1,00/min
      idleGracePeriodSeconds: 600, // 10 minutos de carência
      currency: 'BRL',
    },
  })

  await prisma.tariffAssignment.upsert({
    where: { id: 'seed-tariff-assignment-cp001' },
    update: {},
    create: {
      id: 'seed-tariff-assignment-cp001',
      tariffId: tariff.id,
      operatorId: operator.id,
      scope: 'CHARGE_POINT',
      chargePointId: chargePoint.id,
      priority: 0,
      validFrom: new Date('2026-01-01T00:00:00Z'),
    },
  })

  // --- Usuários ---

  const adminPassword = 'admin123456'
  const admin = await prisma.user.upsert({
    where: { email: 'admin@innoelektron.example.com' },
    update: {},
    create: {
      role: 'ADMIN',
      name: 'Admin da Plataforma',
      email: 'admin@innoelektron.example.com',
      passwordHash: await hash(adminPassword),
    },
  })

  const staffPassword = 'staff123456'
  const operatorStaff = await prisma.user.upsert({
    where: { email: 'staff@innoelektron-operacoes.example.com' },
    update: {},
    create: {
      role: 'OPERATOR',
      operatorId: operator.id,
      name: 'Staff do Operador',
      email: 'staff@innoelektron-operacoes.example.com',
      passwordHash: await hash(staffPassword),
    },
  })

  const driverPassword = 'driver123456'
  const driver = await prisma.user.upsert({
    where: { email: 'motorista.teste@innoelektron.example.com' },
    update: {},
    create: {
      role: 'DRIVER',
      name: 'Motorista de Teste',
      email: 'motorista.teste@innoelektron.example.com',
      phone: '+55 11 91234-5678',
      passwordHash: await hash(driverPassword),
    },
  })

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

  const wallet = await prisma.wallet.upsert({
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

  console.log('[seed] operador:', operator.name)
  console.log('[seed] site:', site.name)
  console.log('[seed] charge point:', chargePoint.ocppIdentity, '— conectores: CCS2 #1, AC Tipo 2 #2')
  console.log('[seed] connector CCS2 id interno:', connectorCcs2.id)
  console.log('[seed] tariff:', tariff.name, '— idle fee', tariff.idleFeePerMinute, 'centavos/min')
  console.log('[seed] usuários:', admin.email, '(ADMIN),', operatorStaff.email, '(OPERATOR),', driver.email, '(DRIVER)')
  console.log('[seed] senhas de teste (dev only, NUNCA use em produção):')
  console.log(`[seed]   ${admin.email} / ${adminPassword}`)
  console.log(`[seed]   ${operatorStaff.email} / ${staffPassword}`)
  console.log(`[seed]   ${driver.email} / ${driverPassword}`)
  console.log('[seed] basic auth do charge point CP-INNOELEKTRON-001: changeme-basic-auth-secret')
  console.log('[seed] wallet do motorista:', wallet.id, '— saldo inicial R$ 50,00')
}

main()
  .catch((err) => {
    console.error(err)
    process.exit(1)
  })
  .finally(async () => {
    await prisma.$disconnect()
  })
