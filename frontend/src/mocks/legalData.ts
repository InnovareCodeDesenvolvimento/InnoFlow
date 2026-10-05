/**
 * Mock de PRIVACIDADE/LGPD: termos e consentimento (L1.9) e exportação/exclusão de conta (L1.4). Segue o contrato de `types/api.ts` e as regras lidas em
 * `backend/src/api/routes/{publicLegal,meConsents,meDataExport,meAccount}.routes.ts` e `services/lgpd/excluirConta.ts`. NÃO é regra de negócio nova: é o suficiente para provar no
 * navegador que as telas falam o contrato. O estado vive na PÁGINA (como o resto do MSW): `page.goto` o zera.
 *
 * Personas (ver `mocks/data.ts`; todas com a senha `senha1234`, exceto a só-Google):
 *  - `exclusao@`         saldo R$ 50,00 (pede a chave Pix), sem dívida, entra por senha;
 *  - `exclusao-zero@`    saldo R$ 0,00 (sem passo da chave Pix);
 *  - `exclusao-google@`  conta SÓ-GOOGLE (sem senha) com saldo: entra por `localStorage["mock:google-as"]="user_driver_exclusao_google"` e reautentica com o Google;
 *  - `devedor@`          dívida em aberto (bloqueia no 1º passo e, se forçado, 409 `OPEN_DEBT`);
 *  - `travado@`          tem sessão ativa travada (409 `ACTIVE_SESSION` no envio);
 *  - `termos@`           tem aceite de versão ANTIGA dos termos (o app abre o pedido de novo aceite);
 *  qualquer outro motorista está em dia com os termos.
 *
 * Gatilhos por `localStorage` (os handlers rodam na página):
 *  - `mock:legal-get`          = `network` | `500` | `slow`   -> falha o GET /api/public/legal;
 *  - `mock:legal-company`      = `full`                        -> devolve dados FICTÍCIOS da empresa (sem isto, todos `null`, como hoje em produção: o dono ainda não informou);
 *  - `mock:legal-version`      = texto                         -> versão vigente dos termos (padrão `2026-10-01`);
 *  - `mock:legal-bump`         = `1`                           -> o PRIMEIRO envio de aceite (cadastro/Google/consents) devolve 409 `TERMS_VERSION_OUTDATED` e a versão vigente sobe;
 *  - `mock:consents`           = `outdated`                    -> qualquer motorista aparece com aceite antigo (`upToDate=false`);
 *  - `mock:consents-get`       = `500` | `network`             -> falha o GET /api/me/consents (o app não deve atrapalhar);
 *  - `mock:consents-post`      = `500` | `network` | `429`     -> falha o POST /api/me/consents;
 *  - `mock:google-new`         = `1`                           -> o "Google (mock)" é uma conta NOVA (cria conta: exige o aceite dos Termos);
 *  - `mock:export-fail`        = `network` | `500` | `429` | `429-header` (com Retry-After 7200) | `slow`;  (o limite real de 3 por dia também vale: a 4ª chamada na página é 429)
 *  - `mock:deletion-fail`      = `network` | `500` | `ACTIVE_SESSION` | `PAYMENT_IN_PROGRESS` | `OPEN_DEBT` | `REFUND_PIX_KEY_REQUIRED` | `RATE_LIMITED_ACCOUNT_DELETION` | `PAYMENT_SECRETS_KEY_MISSING` |
 *                                 `STEPUP_UNAVAILABLE` | `INVALID_GOOGLE_TOKEN` | `FORBIDDEN` | `slow`   -> falha o POST da exclusão (uma vez por gatilho: `once` = prefixo `once:`).
 */
import { parsePixKey } from "@/lib/pixKey"
import type { MeConsentStatus, PublicLegalConfig } from "@/types/api"

export const LEGAL_PRIVACY_VERSION = "2026-10-01"
const DEFAULT_TERMS_VERSION = "2026-10-01"
const BUMPED_TERMS_VERSION = "2026-10-02"
const OLD_VERSION = "2026-05-01"

export const TERMS_OUTDATED_PERSONA_ID = "user_driver_termos"

let bumped = false

function knob(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

/** Versão vigente dos termos: a do gatilho, ou a padrão; depois de um `mock:legal-bump` disparado, a seguinte. */
export function currentTermsVersion(): string {
  if (bumped) return BUMPED_TERMS_VERSION
  return knob("mock:legal-version") ?? DEFAULT_TERMS_VERSION
}

/** `mock:legal-bump=1`: o primeiro aceite enviado volta 409 e a versão vigente sobe (simula "mudou entre o carregamento da tela e o envio"). `true` = deve responder 409 agora. */
export function consumeLegalBump(sentVersion: string | undefined): boolean {
  if (bumped || knob("mock:legal-bump") !== "1") return false
  if (sentVersion === undefined) return false
  bumped = true
  return true
}

export function legalConfig(): PublicLegalConfig {
  const full = knob("mock:legal-company") === "full"
  return {
    termsVersion: currentTermsVersion(),
    privacyVersion: LEGAL_PRIVACY_VERSION,
    company: full
      ? {
          name: "Empresa Exemplo de Mobilidade Elétrica Ltda (dado fictício do mock)",
          cnpj: "11.222.333/0001-81",
          supportEmail: "suporte@exemplo.invalid",
          supportPhone: "(11) 4000-0000",
          dpoEmail: "dpo@exemplo.invalid",
        }
      : { name: null, cnpj: null, supportEmail: null, supportPhone: null, dpoEmail: null },
  }
}

// ---- Consentimento ------------------------------------------------------------------------------------------------------------------------------------

interface ConsentState {
  termsVersion: string
  privacyVersion: string
  acceptedAt: string
}
const consents = new Map<string, ConsentState>()

function consentFor(userId: string): ConsentState {
  let c = consents.get(userId)
  if (!c) {
    const outdated = userId === TERMS_OUTDATED_PERSONA_ID || knob("mock:consents") === "outdated"
    c = outdated
      ? { termsVersion: OLD_VERSION, privacyVersion: OLD_VERSION, acceptedAt: "2026-05-01T12:00:00.000Z" }
      : { termsVersion: currentTermsVersion(), privacyVersion: LEGAL_PRIVACY_VERSION, acceptedAt: "2026-09-01T12:00:00.000Z" }
    consents.set(userId, c)
  }
  return c
}

export function getConsentStatus(userId: string): MeConsentStatus {
  const c = consentFor(userId)
  return {
    termsVersion: c.termsVersion,
    privacyVersion: c.privacyVersion,
    acceptedAt: c.acceptedAt,
    upToDate: c.termsVersion === currentTermsVersion() && c.privacyVersion === LEGAL_PRIVACY_VERSION,
  }
}

export function acceptConsents(userId: string, termsVersion: string, privacyVersion: string): MeConsentStatus {
  consents.set(userId, { termsVersion, privacyVersion, acceptedAt: new Date().toISOString() })
  return getConsentStatus(userId)
}

/** Quem se cadastra pelo mock já aceitou a vigente (o servidor a exige para criar a conta). */
export function recordSignupConsent(userId: string, termsVersion: string): void {
  consents.set(userId, { termsVersion, privacyVersion: LEGAL_PRIVACY_VERSION, acceptedAt: new Date().toISOString() })
}

// ---- Exportação ---------------------------------------------------------------------------------------------------------------------------------------

/** Limite real: 3 exportações por dia por usuário (a 4ª é 429 `RATE_LIMITED_EXPORT`). Aqui, por vida da página. */
const exportCount = new Map<string, number>()
export function registerExport(userId: string): boolean {
  const n = (exportCount.get(userId) ?? 0) + 1
  exportCount.set(userId, n)
  return n <= 3
}

// ---- Exclusão -----------------------------------------------------------------------------------------------------------------------------------------

export interface MockDeletionRecord {
  userId: string
  balanceCentsAtRequest: number
  status: "DELETED" | "DELETED_PENDING_REFUND"
  /** Só o FORMATO canônico fica (no servidor real, cifrada e apagada na devolução). */
  refundPixKeyKind: string | null
}
const deletions: MockDeletionRecord[] = []
export function listMockDeletions(): readonly MockDeletionRecord[] {
  return deletions
}

/** Chave Pix: mesma regra do servidor (`core/lgpd/chavePix.ts`) - vazia = ausente. */
export function pixKeyState(raw: unknown): "ABSENT" | "INVALID" | { kind: string } {
  if (typeof raw !== "string" || raw.trim() === "") return "ABSENT"
  const parsed = parsePixKey(raw)
  return parsed ? { kind: parsed.kind } : "INVALID"
}

export function recordDeletion(record: MockDeletionRecord): void {
  deletions.push(record)
}

const onceUsed = new Set<string>()
/** `mock:deletion-fail=once:CODE` falha só a 1ª tentativa; sem `once:`, falha sempre. Devolve o código a forçar (ou `null`). */
export function forcedDeletionFailure(): string | null {
  const raw = knob("mock:deletion-fail")
  if (!raw) return null
  if (raw.startsWith("once:")) {
    const code = raw.slice(5)
    if (onceUsed.has(code)) return null
    onceUsed.add(code)
    return code
  }
  return raw
}
