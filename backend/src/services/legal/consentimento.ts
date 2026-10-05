import type { ConsentSource, Prisma } from '@prisma/client'
import { prisma } from '../../lib/prisma'
import { AppError } from '../../api/middleware/errorHandler'
import { avaliarConsentimento, type DadosPublicosDaEmpresa, type StatusDeConsentimento, type VersoesVigentes } from '../../core/legal/termos'
import { getDadosLegais, getDadosLegaisEstrito } from './dadosLegais'

/**
 * Termos de uso e política de privacidade (L1.9): versão vigente (painel > env `LEGAL_*`, ver `dadosLegais.ts`), prova do aceite (`ConsentRecord`) e os dados públicos da empresa.
 * A regra "quem está em dia" mora em `core/legal/termos.ts`; aqui só a ligação com env e banco.
 *
 * Aceite = uma linha por (usuário, documento, versão), idempotente (`ON CONFLICT DO NOTHING`, via `skipDuplicates`). Só o IP da requisição é guardado (a coluna não tem
 * user-agent — o plano previu só o IP); truncado em 64 (largura da coluna).
 */

const TAMANHO_MAXIMO_IP = 64

/** Versões VIGENTES (painel > env). ESTRITA: banco fora => 503 — nunca se grava um aceite contra uma versão que pode não ser a do banco. */
export async function versoesVigentes(): Promise<VersoesVigentes> {
  return (await getDadosLegaisEstrito()).versoes
}

/** Dados públicos da empresa (painel > env). Campo vazio = `null` (sem placeholder). Nunca lança: banco fora => env. */
export async function dadosPublicosDaEmpresa(): Promise<Required<DadosPublicosDaEmpresa>> {
  return (await getDadosLegais()).empresa
}

/** Versão que o cliente diz ter aceitado precisa ser a VIGENTE — senão o texto que ele viu não é o que vale (409, o front recarrega `GET /api/public/legal`). */
export async function exigirVersaoVigenteDosTermos(versaoAceita: string): Promise<VersoesVigentes> {
  const vigentes = await versoesVigentes()
  if (versaoAceita !== vigentes.termsVersion) {
    throw new AppError('Os Termos de Uso foram atualizados. Leia a versão atual e aceite novamente.', 409, 'TERMS_VERSION_OUTDATED')
  }
  return vigentes // UMA leitura: termos e privacidade do mesmo instante (o cadastro grava os dois)
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
  return avaliarConsentimento(await versoesVigentes(), aceites)
}

/** `POST /api/me/consents`: reaceite de quem já tem conta. Idempotente (reaceitar a mesma versão não duplica nem falha). */
export async function registrarReaceite(params: { userId: string; termsVersion: string; privacyVersion: string; ip: string | undefined | null }): Promise<StatusDeConsentimento> {
  const vigentes = await versoesVigentes()
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
