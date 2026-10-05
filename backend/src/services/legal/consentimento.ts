import type { ConsentSource, Prisma } from '@prisma/client'
import { prisma } from '../../lib/prisma'
import { env } from '../../lib/env'
import { logger } from '../../lib/logger'
import { AppError } from '../../api/middleware/errorHandler'
import { avaliarConsentimento, normalizarDadosDaEmpresa, type DadosPublicosDaEmpresa, type StatusDeConsentimento, type VersoesVigentes } from '../../core/legal/termos'

/**
 * Termos de uso e política de privacidade (L1.9): versão vigente (env `LEGAL_*`), prova do aceite (`ConsentRecord`) e os dados públicos da empresa.
 * A regra "quem está em dia" mora em `core/legal/termos.ts`; aqui só a ligação com env e banco.
 *
 * Aceite = uma linha por (usuário, documento, versão), idempotente (`ON CONFLICT DO NOTHING`, via `skipDuplicates`). Só o IP da requisição é guardado (a coluna não tem
 * user-agent — o plano previu só o IP); truncado em 64 (largura da coluna).
 */

const TAMANHO_MAXIMO_IP = 64

export function versoesVigentes(): VersoesVigentes {
  return { termsVersion: env.LEGAL_TERMS_VERSION, privacyVersion: env.LEGAL_PRIVACY_VERSION }
}

let avisouCamposInvalidos = false

/** Dados públicos da empresa vindos da env. Campo ausente = `null` (sem placeholder); campo inválido = `null` + um aviso (só o NOME do campo, nunca o valor) por processo. */
export function dadosPublicosDaEmpresa(): DadosPublicosDaEmpresa {
  const { dados, invalidos } = normalizarDadosDaEmpresa({
    name: env.LEGAL_COMPANY_NAME,
    cnpj: env.LEGAL_COMPANY_CNPJ,
    supportEmail: env.LEGAL_SUPPORT_EMAIL,
    supportPhone: env.LEGAL_SUPPORT_PHONE,
    dpoEmail: env.LEGAL_DPO_EMAIL,
  })
  if (invalidos.length > 0 && !avisouCamposInvalidos) {
    avisouCamposInvalidos = true
    logger.warn({ campos: invalidos }, '[legal] variável LEGAL_* com valor inválido — o campo sai vazio em /api/public/legal até ser corrigida')
  }
  return dados
}

/** Versão que o cliente diz ter aceitado precisa ser a VIGENTE — senão o texto que ele viu não é o que vale (409, o front recarrega `GET /api/public/legal`). */
export function exigirVersaoVigenteDosTermos(versaoAceita: string): void {
  if (versaoAceita !== versoesVigentes().termsVersion) {
    throw new AppError('Os Termos de Uso foram atualizados. Leia a versão atual e aceite novamente.', 409, 'TERMS_VERSION_OUTDATED')
  }
}

export function ipDoAceite(ip: string | undefined | null): string | null {
  if (!ip) return null
  return ip.slice(0, TAMANHO_MAXIMO_IP)
}

/**
 * Linhas de aceite para um cadastro: termos na versão que o usuário aceitou (já validada como vigente) e a política de privacidade na versão vigente — o cadastro aceita os dois
 * documentos num único gesto. Uso: `consentRecords: { create: aceitesDoCadastro(...) }` dentro do MESMO `user.create` (atômico: conta sem aceite não existe).
 */
export function aceitesDoCadastro(params: { termsVersion: string; privacyVersion: string; origem: ConsentSource; ip: string | undefined | null }): Prisma.ConsentRecordCreateWithoutUserInput[] {
  const ip = ipDoAceite(params.ip)
  return [
    { kind: 'TERMS', version: params.termsVersion, source: params.origem, ip },
    { kind: 'PRIVACY', version: params.privacyVersion, source: params.origem, ip },
  ]
}

export async function statusDoConsentimento(userId: string): Promise<StatusDeConsentimento> {
  const aceites = await prisma.consentRecord.findMany({ where: { userId }, select: { kind: true, version: true, acceptedAt: true }, orderBy: { acceptedAt: 'desc' }, take: 200 })
  return avaliarConsentimento(versoesVigentes(), aceites)
}

/** `POST /api/me/consents`: reaceite de quem já tem conta. Idempotente (reaceitar a mesma versão não duplica nem falha). */
export async function registrarReaceite(params: { userId: string; termsVersion: string; privacyVersion: string; ip: string | undefined | null }): Promise<StatusDeConsentimento> {
  const vigentes = versoesVigentes()
  if (params.termsVersion !== vigentes.termsVersion || params.privacyVersion !== vigentes.privacyVersion) {
    throw new AppError('Os documentos legais foram atualizados. Leia as versões atuais e aceite novamente.', 409, 'TERMS_VERSION_OUTDATED')
  }
  const ip = ipDoAceite(params.ip)
  await prisma.consentRecord.createMany({
    data: [
      { userId: params.userId, kind: 'TERMS', version: params.termsVersion, source: 'REACCEPT', ip },
      { userId: params.userId, kind: 'PRIVACY', version: params.privacyVersion, source: 'REACCEPT', ip },
    ],
    skipDuplicates: true,
  })
  return statusDoConsentimento(params.userId)
}
