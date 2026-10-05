import { prisma } from '../../lib/prisma'
import { env } from '../../lib/env'
import { AppError } from '../../api/middleware/errorHandler'
import type { IdentidadeGoogle } from '../../core/auth/decidirAcaoGoogle'
import { escolherMetodoDeReautenticacao, identidadeGoogleConfere } from '../../core/lgpd/reautenticacao'
import { createGoogleTokenVerifier } from '../auth/googleTokenVerifier'
import { exigirSenhaDoTitular } from '../auth/stepUpSenha'

/**
 * Reautenticação do titular antes da exclusão da conta (regras em `core/lgpd/reautenticacao.ts`). A senha passa pelo step-up com tranca por tentativas (Redis, 5 erros/15 min,
 * fail-closed); o ID token do Google é verificado contra as chaves públicas do Google (assinatura, `aud`, `iss`, `exp`) e o `sub` precisa ser o da conta.
 * NUNCA loga/devolve a senha nem o `credential` (um JWT: a mensagem de erro da lib do Google o embute, por isso o `catch` abaixo descarta o erro).
 */

export interface PortasDeReautenticacao {
  exigirSenha(params: { userId: string; senhaInformada: string }): Promise<void>
  verificarIdTokenDoGoogle(credential: string): Promise<IdentidadeGoogle>
}

const portasReais: PortasDeReautenticacao = {
  exigirSenha: exigirSenhaDoTitular,
  async verificarIdTokenDoGoogle(credential) {
    const clientId = env.GOOGLE_CLIENT_ID
    if (!clientId) throw new AppError('Login com Google não está configurado.', 503, 'GOOGLE_NOT_CONFIGURED')
    return createGoogleTokenVerifier(clientId)(credential)
  },
}

export async function confirmarIdentidadeDoTitular(
  userId: string,
  prova: { currentPassword?: string | undefined; googleCredential?: string | undefined },
  portas: PortasDeReautenticacao = portasReais,
): Promise<void> {
  const conta = await prisma.user.findUnique({ where: { id: userId }, select: { passwordHash: true, googleSub: true } })
  if (!conta) throw new AppError('Token inválido ou expirado.', 401, 'UNAUTHORIZED')

  const escolha = escolherMetodoDeReautenticacao(
    { temSenha: conta.passwordHash !== null, temGoogle: conta.googleSub !== null },
    { senhaInformada: !!prova.currentPassword, googleInformado: !!prova.googleCredential },
  )

  switch (escolha.metodo) {
    case 'SENHA':
      await portas.exigirSenha({ userId, senhaInformada: prova.currentPassword! })
      return
    case 'GOOGLE': {
      let identidade: IdentidadeGoogle
      try {
        identidade = await portas.verificarIdTokenDoGoogle(prova.googleCredential!)
      } catch (err) {
        if (err instanceof AppError) throw err // ex.: 503 GOOGLE_NOT_CONFIGURED
        throw new AppError('Token do Google inválido.', 401, 'INVALID_GOOGLE_TOKEN') // sem `err`: a mensagem da lib embute o JWT
      }
      if (!identidadeGoogleConfere(identidade, conta.googleSub!)) throw new AppError('Token do Google inválido.', 401, 'INVALID_GOOGLE_TOKEN')
      return
    }
    case 'NENHUM':
      if (escolha.erro === 'CURRENT_PASSWORD_REQUIRED') throw new AppError('Informe sua senha atual para excluir a conta.', 400, 'CURRENT_PASSWORD_REQUIRED')
      if (escolha.erro === 'GOOGLE_CREDENTIAL_REQUIRED') throw new AppError('Confirme com a sua conta Google para excluir a conta.', 400, 'VALIDATION_ERROR', [{ path: 'googleCredential', message: 'obrigatório para conta sem senha' }])
      throw new AppError('Não foi possível confirmar a sua identidade. Fale com o suporte.', 403, 'FORBIDDEN')
  }
}
