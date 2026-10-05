import type { CompanyProfile, Prisma } from '@prisma/client'
import { prisma } from '../../lib/prisma'
import { env } from '../../lib/env'
import { logger } from '../../lib/logger'
import { diffEntity, type EntityDiff } from '../../core/auditoria/diffEntity'
import { validarENormalizarCnpj } from '../../core/legal/cnpj'
import { resolverDadosLegais, type LinhaPerfilEmpresa } from '../../core/legal/dadosLegais'
import { AppError } from '../../api/middleware/errorHandler'
import type { UpdateCompanyProfileBody } from '../../api/schemas/companyProfile.schema'
import { writeAuditLog } from '../auditoria/writeAuditLog'
import { invalidarCacheDadosLegais } from './dadosLegais'

/**
 * Grava os dados da empresa — `PUT /api/admin/company-profile`. Mesmo desenho de `atualizarConfigComunicacao`:
 *  - AUDITORIA FAIL-CLOSED: o update e a linha de `AuditLog` (`UPDATE`, entidade `CompanyProfile`) saem na MESMA transação; se a auditoria falhar, nada é gravado.
 *  - CONCORRÊNCIA: `INSERT ... ON CONFLICT DO NOTHING` garante a linha singleton e `SELECT ... FOR UPDATE` a trava até o commit (dois admins gravando juntos se serializam).
 *  - AUDITORIA SEM PII: dado de empresa (razão social, CNPJ, site) e as versões entram com valor antes/depois; e-mail e telefone de suporte, endereço e o encarregado (nome e e-mail:
 *    pessoa física, mesmo sendo contato institucional) entram SÓ como `{changed: true}` — a tabela é imutável por 24 meses.
 *  - MUDAR A VERSÃO dos Termos/Privacidade exige `confirmVersionChange: true`: todos os motoristas passam a `upToDate=false` e precisam aceitar de novo. Sem a confirmação: 409
 *    `VERSION_CHANGE_NOT_CONFIRMED` e NADA é gravado (nem os outros campos do mesmo PUT).
 *  - 1ª GRAVAÇÃO DOS DADOS DA EMPRESA "IMPORTA" a env: a partir dela o painel assume o grupo inteiro (a env deixa de completar campo vazio — ver `core/legal/dadosLegais.ts`); sem importar, um PUT
 *    só com a razão social faria o CNPJ e o suporte que estavam na env sumirem da página pública sem o dono ter pedido.
 */

export interface AtorPerfilEmpresa {
  userId: string
  role: 'ADMIN' | 'OPERATOR' | 'DRIVER'
  email: string
  name: string
  operatorId: string | null
}

export interface RequisicaoPerfilEmpresa {
  method: string
  path: string
  ipAddress: string | null
  userAgent: string | null
  requestId: string | null
}

/** Campos da empresa (o PUT que toca algum deles faz o painel assumir o grupo). */
const CAMPOS_DA_EMPRESA = ['legalName', 'tradeName', 'cnpj', 'supportEmail', 'supportPhone', 'address', 'website', 'dpoName', 'dpoEmail'] as const
type CampoDaEmpresa = (typeof CAMPOS_DA_EMPRESA)[number]
const CAMPOS_DE_VERSAO = ['termsVersion', 'privacyVersion'] as const

/** Entram na auditoria COM valor (dado de pessoa jurídica ou versão de documento). */
const CAMPOS_COM_VALOR = ['legalName', 'tradeName', 'cnpj', 'website', 'termsVersion', 'privacyVersion'] as const
/** Entram na auditoria SÓ como `{changed: true}`. */
const CAMPOS_SO_O_NOME = ['supportEmail', 'supportPhone', 'address', 'dpoName', 'dpoEmail'] as const

type Snapshot = Pick<CompanyProfile, CampoDaEmpresa | (typeof CAMPOS_DE_VERSAO)[number]>

const snapshotAuditavel = (r: Snapshot): Record<string, unknown> => Object.fromEntries([...CAMPOS_COM_VALOR, ...CAMPOS_SO_O_NOME].map((c) => [c, r[c]]))

function linhaParaResolver(r: CompanyProfile): LinhaPerfilEmpresa {
  return {
    legalName: r.legalName,
    tradeName: r.tradeName,
    cnpj: r.cnpj,
    supportEmail: r.supportEmail,
    supportPhone: r.supportPhone,
    address: r.address,
    website: r.website,
    dpoName: r.dpoName,
    dpoEmail: r.dpoEmail,
    termsVersion: r.termsVersion,
    privacyVersion: r.privacyVersion,
    companyDataSavedAt: r.companyDataSavedAt,
    updatedByUserId: r.updatedByUserId,
    updatedAt: r.updatedAt,
  }
}

/** O que a env já informa hoje, no formato da coluna (CNPJ só com os 14 caracteres) — usado para importar na 1ª gravação. */
function importavelDaEnv(): Partial<Record<CampoDaEmpresa, string>> {
  const { empresa } = resolverDadosLegais(null, env)
  const saida: Partial<Record<CampoDaEmpresa, string>> = {}
  if (empresa.name) saida.legalName = empresa.name
  if (empresa.cnpj) {
    const n = validarENormalizarCnpj(empresa.cnpj)
    if (n) saida.cnpj = n
  }
  if (empresa.supportEmail) saida.supportEmail = empresa.supportEmail
  if (empresa.supportPhone) saida.supportPhone = empresa.supportPhone
  if (empresa.dpoEmail) saida.dpoEmail = empresa.dpoEmail
  return saida
}

export async function atualizarPerfilEmpresa(params: { body: UpdateCompanyProfileBody; actor: AtorPerfilEmpresa; request: RequisicaoPerfilEmpresa }): Promise<{ camposAlterados: string[]; versaoAlterada: boolean }> {
  const { body, actor, request } = params

  const resultado = await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`INSERT INTO "CompanyProfile" ("id", "updatedAt") VALUES (1, NOW()) ON CONFLICT ("id") DO NOTHING`
    await tx.$queryRaw`SELECT "id" FROM "CompanyProfile" WHERE "id" = 1 FOR UPDATE`
    const antes = await tx.companyProfile.findUniqueOrThrow({ where: { id: 1 } })

    const data: Prisma.CompanyProfileUpdateInput = { updatedByUserId: actor.userId }
    const tocouEmpresa = CAMPOS_DA_EMPRESA.some((c) => body[c] !== undefined)

    // 1ª gravação da empresa: o painel assume o grupo; o que a env já informava é importado para o que o PUT não mencionou.
    if (tocouEmpresa && antes.companyDataSavedAt === null) {
      const daEnv = importavelDaEnv()
      for (const c of CAMPOS_DA_EMPRESA) if (body[c] === undefined && daEnv[c] !== undefined) data[c] = daEnv[c]
    }
    for (const c of CAMPOS_DA_EMPRESA) if (body[c] !== undefined) data[c] = body[c]
    if (tocouEmpresa) data.companyDataSavedAt = new Date()
    for (const c of CAMPOS_DE_VERSAO) if (body[c] !== undefined) data[c] = body[c]

    // Versão EFETIVA antes x depois (considera a env como reserva): mudar de `null` para o mesmo valor que a env já tinha NÃO muda nada.
    const efetivasAntes = resolverDadosLegais(linhaParaResolver(antes), env).versoes
    const proximaLinha: LinhaPerfilEmpresa = {
      ...linhaParaResolver(antes),
      termsVersion: body.termsVersion !== undefined ? body.termsVersion : antes.termsVersion,
      privacyVersion: body.privacyVersion !== undefined ? body.privacyVersion : antes.privacyVersion,
    }
    const efetivasDepois = resolverDadosLegais(proximaLinha, env).versoes
    const versaoAlterada = efetivasAntes.termsVersion !== efetivasDepois.termsVersion || efetivasAntes.privacyVersion !== efetivasDepois.privacyVersion

    if (versaoAlterada && body.confirmVersionChange !== true) {
      const motoristasAfetados = await tx.user.count({ where: { role: 'DRIVER', deletedAt: null } })
      throw new AppError(
        'Mudar a versão dos Termos ou da Política de Privacidade obriga todos os motoristas a aceitar de novo no próximo acesso. Confirme para continuar.',
        409,
        'VERSION_CHANGE_NOT_CONFIRMED',
        [{ field: 'confirmVersionChange', reason: 'REQUIRED_TRUE', currentTermsVersion: efetivasAntes.termsVersion, currentPrivacyVersion: efetivasAntes.privacyVersion, newTermsVersion: efetivasDepois.termsVersion, newPrivacyVersion: efetivasDepois.privacyVersion, driversAffected: motoristasAfetados }],
      )
    }

    const depois = await tx.companyProfile.update({ where: { id: 1 }, data })

    const changes: EntityDiff = { ...(diffEntity(snapshotAuditavel(antes), snapshotAuditavel(depois), CAMPOS_COM_VALOR) ?? {}) }
    for (const c of CAMPOS_SO_O_NOME) if ((antes[c] ?? null) !== (depois[c] ?? null)) changes[c] = { changed: true } // marcador — NUNCA o valor
    if (versaoAlterada) changes.versionChangeConfirmed = true

    // FAIL-CLOSED: se isto lançar, o `$transaction` inteiro reverte.
    await writeAuditLog(
      {
        actorUserId: actor.userId,
        actorRole: actor.role,
        actorEmail: actor.email,
        actorName: actor.name,
        actorOperatorId: actor.operatorId,
        action: 'UPDATE',
        actionDetail: versaoAlterada ? 'company_profile:legal_version_changed' : 'company_profile',
        outcome: 'SUCCESS',
        httpStatus: 200,
        entityType: 'CompanyProfile',
        entityId: '1',
        method: request.method,
        path: request.path,
        ipAddress: request.ipAddress,
        userAgent: request.userAgent,
        requestId: request.requestId,
        changes: Object.keys(changes).length > 0 ? changes : null,
      },
      tx,
    )
    return { camposAlterados: Object.keys(changes).filter((k) => k !== 'versionChangeConfirmed'), versaoAlterada }
  })

  // Só NOMES de campos (nunca valores).
  logger.info({ event: 'company_profile_updated', actorUserId: actor.userId, changedFields: resultado.camposAlterados, legalVersionChanged: resultado.versaoAlterada }, '[legal] dados da empresa atualizados pelo admin')
  invalidarCacheDadosLegais()
  return resultado
}
