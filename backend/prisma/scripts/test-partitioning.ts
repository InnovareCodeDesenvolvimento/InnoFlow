/**
 * Prova de que o particionamento mensal de MeterSample/OcppMessage está
 * roteando de verdade — insere uma linha em setembro/2026 e outra em
 * outubro/2026 em cada tabela, e confirma (via `tableoid::regclass`, que
 * devolve o nome físico da partição que armazenou a linha) que cada uma
 * caiu na partição do mês certo, não todas na mesma ou na DEFAULT.
 *
 * Self-contido: cria seu próprio Operator/Site/ChargePoint (upsert, não
 * depende do seed.ts já ter rodado) e limpa as linhas de teste no final —
 * pode rodar várias vezes sem deixar sujeira nem duplicar fixtures.
 *
 * Uso: npm run db:test-partitioning  (precisa de DATABASE_URL apontando
 * para um Postgres com a migration `20260916120000_init_multi_tenant_partitioned`
 * já aplicada).
 */
import { PrismaClient } from '@prisma/client'
import { createHash } from 'node:crypto'

const prisma = new PrismaClient()

type PartitionRow = { partition: string }

async function expectPartition(
  label: string,
  query: Promise<PartitionRow[]>,
  expectedPartition: string,
): Promise<boolean> {
  const rows = await query
  const actual = rows[0]?.partition
  const ok = actual === expectedPartition
  console.log(
    `[test-partitioning] ${ok ? 'PASS' : 'FAIL'} — ${label}: esperado "${expectedPartition}", veio "${actual ?? '(nada encontrado)'}"`,
  )
  return ok
}

async function main() {
  const operator = await prisma.operator.upsert({
    where: { cnpj: '00000000000191' },
    update: {},
    create: {
      name: '[test-partitioning] Operator fixture',
      cnpj: '00000000000191',
      email: 'test-partitioning@innoelektron.example.com',
    },
  })

  const site = await prisma.site.upsert({
    where: { id: 'test-partitioning-site' },
    update: {},
    create: {
      id: 'test-partitioning-site',
      operatorId: operator.id,
      name: '[test-partitioning] Site fixture',
      addressLine: 'Rua de Teste, 0',
      city: 'São Paulo',
      state: 'SP',
      postalCode: '00000-000',
      latitude: '0',
      longitude: '0',
    },
  })

  const chargePoint = await prisma.chargePoint.upsert({
    where: { ocppIdentity: 'CP-TEST-PARTITIONING' },
    update: {},
    create: {
      siteId: site.id,
      operatorId: operator.id,
      ocppIdentity: 'CP-TEST-PARTITIONING',
      basicAuthSecretHash: createHash('sha256').update('test-partitioning').digest('hex'),
    },
  })

  const results: boolean[] = []

  // --- MeterSample: setembro/2026 vs outubro/2026 ---
  const meterSeptember = await prisma.meterSample.create({
    data: {
      chargePointId: chargePoint.id,
      operatorId: operator.id,
      ts: new Date('2026-09-15T12:00:00Z'),
      measurand: 'Energy.Active.Import.Register',
      value: '1000.0000',
      unit: 'Wh',
    },
  })
  const meterOctober = await prisma.meterSample.create({
    data: {
      chargePointId: chargePoint.id,
      operatorId: operator.id,
      ts: new Date('2026-10-15T12:00:00Z'),
      measurand: 'Energy.Active.Import.Register',
      value: '2000.0000',
      unit: 'Wh',
    },
  })

  results.push(
    await expectPartition(
      'MeterSample de 2026-09-15',
      prisma.$queryRaw<PartitionRow[]>`SELECT tableoid::regclass::text as partition FROM "MeterSample" WHERE id = ${meterSeptember.id}`,
      'MeterSample_2026_09',
    ),
  )
  results.push(
    await expectPartition(
      'MeterSample de 2026-10-15',
      prisma.$queryRaw<PartitionRow[]>`SELECT tableoid::regclass::text as partition FROM "MeterSample" WHERE id = ${meterOctober.id}`,
      'MeterSample_2026_10',
    ),
  )

  // --- OcppMessage: setembro/2026 vs outubro/2026 ---
  const msgSeptember = await prisma.ocppMessage.create({
    data: {
      chargePointId: chargePoint.id,
      operatorId: operator.id,
      direction: 'INBOUND',
      messageType: 'CALL',
      ocppMessageId: 'test-partitioning-sep',
      action: 'Heartbeat',
      payload: { seed: true },
      occurredAt: new Date('2026-09-20T08:00:00Z'),
    },
  })
  const msgOctober = await prisma.ocppMessage.create({
    data: {
      chargePointId: chargePoint.id,
      operatorId: operator.id,
      direction: 'INBOUND',
      messageType: 'CALL',
      ocppMessageId: 'test-partitioning-oct',
      action: 'Heartbeat',
      payload: { seed: true },
      occurredAt: new Date('2026-10-20T08:00:00Z'),
    },
  })

  results.push(
    await expectPartition(
      'OcppMessage de 2026-09-20',
      prisma.$queryRaw<PartitionRow[]>`SELECT tableoid::regclass::text as partition FROM "OcppMessage" WHERE id = ${msgSeptember.id}`,
      'OcppMessage_2026_09',
    ),
  )
  results.push(
    await expectPartition(
      'OcppMessage de 2026-10-20',
      prisma.$queryRaw<PartitionRow[]>`SELECT tableoid::regclass::text as partition FROM "OcppMessage" WHERE id = ${msgOctober.id}`,
      'OcppMessage_2026_10',
    ),
  )

  // Limpeza — mantém o script idempotente entre execuções.
  await prisma.meterSample.deleteMany({ where: { chargePointId: chargePoint.id } })
  await prisma.ocppMessage.deleteMany({ where: { chargePointId: chargePoint.id } })

  const allPassed = results.every(Boolean)
  console.log(
    allPassed
      ? '[test-partitioning] TODAS as linhas caíram na partição mensal certa. ✔'
      : '[test-partitioning] FALHOU — alguma linha caiu na partição errada (ou na DEFAULT). Ver detalhes acima.',
  )
  process.exit(allPassed ? 0 : 1)
}

main()
  .catch((err) => {
    console.error(err)
    process.exit(1)
  })
  .finally(async () => {
    await prisma.$disconnect()
  })
