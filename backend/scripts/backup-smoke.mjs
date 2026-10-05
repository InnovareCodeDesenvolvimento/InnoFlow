/**
 * Prova de que a restauração do backup funciona (job `backup-restore` do CI, .github/workflows/ci.yml).
 *
 * Roda contra um Postgres de verdade, em atos:
 *   1) `semear`     grava linhas conhecidas no banco (inclusive em tabelas PARTICIONADAS e com gatilhos de somente-anexar)
 *   2) `contagens`  imprime um retrato do banco: linhas por tabela e quantidade de índices, gatilhos, funções e constraints
 *   3) (o workflow faz o dump cifrado, APAGA o schema inteiro e restaura)
 *   4) `conferir`   exige que aquelas mesmas linhas estejam de volta, e `contagens` de novo tem que ser IDÊNTICO ao do passo 2
 *
 * Backup que nunca foi restaurado é uma suposição, e testar uma vez à mão não basta: o schema muda toda semana. Por isso
 * o ciclo roda a cada push. Mesma abordagem do InnoChat e do Parque das Feiras.
 *
 * Os dados são ATÍPICOS de propósito: acento, cedilha, emoji, decimal com casas fixas, data com fuso, JSON aninhado. Se a
 * restauração perder codificação ou precisão, é aqui que aparece, e não na primeira conta de um motorista.
 *
 * Só usa tabelas e colunas obrigatórias que o negócio não consegue dispensar (Operator, Site, ChargePoint, User, Wallet,
 * WalletEntry, MeterSample, OcppMessage, AuditLog): se uma migration futura mudar o contrato delas, este script quebra
 * junto, e é o aviso certo.
 *
 * Uso: node scripts/backup-smoke.mjs semear|conferir|contagens   (DATABASE_URL no ambiente; o Prisma Client já gerado)
 */
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

const MARCA = "backup-smoke";
const OPERATOR_NAME = "Eletroposto da Ação, Cãmisas & Açaí ⚡🔌";
const OPERATOR_EMAIL = `${MARCA}@innoflow.invalid`;
const USER_NAME = "Conceição Müller 🚗";
const USER_EMAIL = `${MARCA}-motorista@innoflow.invalid`;
const CP_IDENTITY = "BACKUP-SMOKE-CP-001";
const LATITUDE = "-23.55052"; // o Prisma devolve Decimal sem zeros à direita
const LONGITUDE = "-46.633308";
const ENERGY_VALUE = "1234.5678";
const METER_TS = new Date("2026-10-15T15:30:00.123Z");
// Uma amostra bem no futuro: cai fora das partições mensais já criadas (vai para a partição padrão, se houver) e prova que
// a restauração não perde linhas por causa de partição.
const METER_TS_FUTURO = new Date("2031-05-17T15:30:00.000Z");
const WALLET_ENTRY_CENTS = 12345;
// jsonb não preserva a ordem das chaves: compara-se o JSON canônico (chaves ordenadas).
const canon = (v) => JSON.stringify(v, (_k, x) => (x && typeof x === "object" && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) : x));
const RAW_JSON = { medidor: "Contador Ação", fases: ["L1", "L2", "L3"], leitura: { kWh: 12.5, nota: "çãõ ⚡" } };

async function semear() {
  const ja = await prisma.operator.findFirst({ where: { email: OPERATOR_EMAIL } }).catch(() => null);
  if (ja) {
    // WalletEntry e AuditLog são somente-anexar (gatilho): não dá para limpar e semear de novo. Banco novo, ou nada a fazer.
    console.log("[smoke] já semeado neste banco; nada a fazer (use um banco novo para semear de novo)");
    return;
  }
  const operator = await prisma.operator.create({ data: { name: OPERATOR_NAME, email: OPERATOR_EMAIL } });
  const site = await prisma.site.create({
    data: {
      operatorId: operator.id,
      name: "Posto Ação & Cia 🌳",
      addressLine: "Av. Paulista, 1000",
      city: "São Paulo",
      state: "SP",
      postalCode: "01310-100",
      latitude: LATITUDE,
      longitude: LONGITUDE,
    },
  });
  const chargePoint = await prisma.chargePoint.create({
    data: { siteId: site.id, operatorId: operator.id, ocppIdentity: CP_IDENTITY, basicAuthSecretHash: "hash-de-teste-nao-e-segredo" },
  });
  const user = await prisma.user.create({ data: { role: "DRIVER", name: USER_NAME, email: USER_EMAIL, cpf: "52998224725" } });
  const wallet = await prisma.wallet.create({ data: { userId: user.id } });
  await prisma.walletEntry.create({
    data: { walletId: wallet.id, type: "TOPUP_PIX", amountCents: WALLET_ENTRY_CENTS, balanceAfterCents: WALLET_ENTRY_CENTS, description: "Recarga Pix de teste ação ⚡" },
  });
  for (const ts of [METER_TS, METER_TS_FUTURO]) {
    await prisma.meterSample.create({
      data: { chargePointId: chargePoint.id, operatorId: operator.id, ts, measurand: "Energy.Active.Import.Register", value: ENERGY_VALUE, unit: "Wh", raw: RAW_JSON },
    });
  }
  await prisma.ocppMessage.create({
    data: {
      chargePointId: chargePoint.id,
      operatorId: operator.id,
      direction: "INBOUND",
      messageType: "CALL",
      ocppMessageId: `${MARCA}-1`,
      action: "BootNotification",
      payload: RAW_JSON,
      occurredAt: METER_TS,
    },
  });
  await prisma.auditLog.create({
    data: {
      actorUserId: user.id,
      actorRole: "SYSTEM",
      actorEmail: USER_EMAIL,
      actorName: USER_NAME,
      action: "OTHER",
      outcome: "SUCCESS",
      actionDetail: "linha de teste do backup-smoke",
      changes: RAW_JSON,
    },
  });
  console.log("[smoke] semeado: operador, ponto, motorista, carteira, 1 lançamento, 2 amostras (2 partições), 1 mensagem OCPP, 1 auditoria");
}

async function conferir() {
  const problems = [];

  const operator = await prisma.operator.findFirst({ where: { email: OPERATOR_EMAIL } });
  if (!operator) problems.push("o operador semeado não voltou");
  else if (operator.name !== OPERATOR_NAME) problems.push(`o nome do operador voltou diferente: ${JSON.stringify(operator.name)}`);

  const user = await prisma.user.findUnique({ where: { email: USER_EMAIL } });
  if (!user) problems.push("o motorista semeado não voltou");
  else if (user.name !== USER_NAME) problems.push("o nome do motorista voltou diferente");

  if (operator) {
    const site = await prisma.site.findFirst({ where: { operatorId: operator.id } });
    if (!site) problems.push("o ponto semeado não voltou");
    else if (String(site.latitude) !== LATITUDE || String(site.longitude) !== LONGITUDE) {
      // Decimal: prova que não virou float pelo caminho.
      problems.push(`as coordenadas voltaram como ${site.latitude}, ${site.longitude}; esperado ${LATITUDE}, ${LONGITUDE}`);
    }
    const chargePoint = await prisma.chargePoint.findUnique({ where: { ocppIdentity: CP_IDENTITY } });
    if (!chargePoint) problems.push("o carregador semeado não voltou");
    else if (chargePoint.operatorId !== operator.id) problems.push("o carregador perdeu o vínculo com o operador");
  }

  if (user) {
    const wallet = await prisma.wallet.findUnique({ where: { userId: user.id }, include: { entries: true } });
    if (!wallet) problems.push("a carteira semeada não voltou");
    else if (wallet.entries.length !== 1 || wallet.entries[0].amountCents !== WALLET_ENTRY_CENTS) problems.push("o lançamento da carteira voltou diferente");
  }

  const samples = await prisma.meterSample.findMany({ where: { operator: { email: OPERATOR_EMAIL } }, orderBy: { ts: "asc" } });
  if (samples.length !== 2) problems.push(`as amostras do medidor voltaram em número diferente: ${samples.length}, esperado 2`);
  else {
    for (const s of samples) {
      if (String(s.value) !== ENERGY_VALUE) problems.push(`o valor do medidor voltou como ${s.value}, esperado ${ENERGY_VALUE}`);
      if (canon(s.raw) !== canon(RAW_JSON)) problems.push("o JSON da amostra voltou diferente");
    }
    // Data com fuso e precisão de milissegundos: prova que a chave de partição sobreviveu.
    if (samples[0].ts.toISOString() !== METER_TS.toISOString()) problems.push(`a data da amostra voltou como ${samples[0].ts.toISOString()}`);
    if (samples[1].ts.toISOString() !== METER_TS_FUTURO.toISOString()) problems.push(`a data da amostra futura voltou como ${samples[1].ts.toISOString()}`);
  }

  const messages = await prisma.ocppMessage.count({ where: { ocppMessageId: `${MARCA}-1` } });
  if (messages !== 1) problems.push(`a mensagem OCPP semeada voltou ${messages} vez(es), esperado 1`);

  const audits = await prisma.auditLog.findMany({ where: { actorEmail: USER_EMAIL } });
  if (audits.length !== 1) problems.push(`a linha de auditoria voltou ${audits.length} vez(es), esperado 1`);
  else if (canon(audits[0].changes) !== canon(RAW_JSON)) problems.push("o JSON da auditoria voltou diferente");

  // O que as migrations criam e que NÃO é dado: se a restauração perdesse os gatilhos de somente-anexar, o livro-razão
  // do motorista voltaria editável. Provado pelo comportamento, não pela contagem.
  try {
    await prisma.$executeRawUnsafe(`UPDATE "WalletEntry" SET "amountCents" = 0 WHERE "description" LIKE 'Recarga Pix de teste%'`);
    problems.push("o gatilho de somente-anexar da WalletEntry sumiu na restauração (um UPDATE passou)");
  } catch {
    /* esperado: o gatilho barra */
  }

  if (problems.length > 0) {
    console.error("[smoke] RESTAURAÇÃO REPROVADA:");
    for (const p of problems) console.error(`  - ${p}`);
    process.exit(1);
  }
  console.log("[smoke] restauração aprovada: operador, ponto, carteira, amostras (2 partições), mensagem OCPP e auditoria voltaram íntegros");
  console.log("[smoke]   acentuação, emoji, decimal, data com fuso, JSON, vínculos entre tabelas e gatilhos de somente-anexar conferidos");
}

/**
 * Retrato exato do banco, uma linha por item, em ordem estável (para `diff` antes x depois). Contagem exata de linhas
 * (EXISTS/COUNT por tabela, não estatística do autovacuum) mais o número de objetos de schema.
 */
async function contagens() {
  const tabelas = await prisma.$queryRawUnsafe(
    `SELECT c.relname AS nome FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind IN ('r','p') ORDER BY c.relname`,
  );
  const linhas = [];
  for (const { nome } of tabelas) {
    const [{ n }] = await prisma.$queryRawUnsafe(`SELECT count(*)::text AS n FROM public."${String(nome).replaceAll('"', '""')}"`);
    linhas.push(`linhas ${nome} ${n}`);
  }
  const objetos = {
    indices: `SELECT count(*) FROM pg_indexes WHERE schemaname = 'public'`,
    gatilhos: `SELECT count(*) FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND NOT t.tgisinternal`,
    funcoes: `SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public'`,
    constraints: `SELECT count(*) FROM pg_constraint k JOIN pg_namespace n ON n.oid = k.connamespace WHERE n.nspname = 'public'`,
    tipos_enum: `SELECT count(*) FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace WHERE n.nspname = 'public' AND t.typtype = 'e'`,
    particoes: `SELECT count(*) FROM pg_inherits i JOIN pg_class c ON c.oid = i.inhrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public'`,
  };
  for (const [nome, sql] of Object.entries(objetos)) {
    const [{ count }] = await prisma.$queryRawUnsafe(sql);
    linhas.push(`objetos ${nome} ${count}`);
  }
  console.log(linhas.join("\n"));
}

const action = process.argv[2];
try {
  if (action === "semear") await semear();
  else if (action === "conferir") await conferir();
  else if (action === "contagens") await contagens();
  else {
    console.error("Uso: node scripts/backup-smoke.mjs semear|conferir|contagens");
    process.exit(1);
  }
} finally {
  await prisma.$disconnect();
}
