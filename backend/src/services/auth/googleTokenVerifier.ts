import { OAuth2Client } from 'google-auth-library'
import type { IdentidadeGoogle } from '../../core/auth/decidirAcaoGoogle'

/**
 * Adaptador real do verificador de ID token (Google Identity Services).
 * `verifyIdToken` valida a ASSINATURA contra as chaves públicas do Google
 * (cache interno da lib), o `aud` (tem que ser o NOSSO client ID — token
 * emitido para outro app é recusado), o `iss` e o `exp`. Qualquer falha lança;
 * quem chama (`autenticarComGoogle`) transforma em `INVALID_TOKEN` sem repassar
 * o erro — a mensagem da lib pode conter o próprio JWT.
 */

// Singleton: o cliente guarda em cache as chaves públicas (evita buscar no
// Google a cada login).
const client = new OAuth2Client()

export function createGoogleTokenVerifier(clientId: string): (credential: string) => Promise<IdentidadeGoogle> {
  return async (credential: string): Promise<IdentidadeGoogle> => {
    const ticket = await client.verifyIdToken({ idToken: credential, audience: clientId })
    const payload = ticket.getPayload()
    if (!payload || !payload.sub || !payload.email) {
      throw new Error('payload do ID token sem sub/email')
    }
    return {
      sub: payload.sub,
      email: payload.email,
      // Estritamente `=== true`: qualquer outra coisa (ausente, string) é "não verificado".
      emailVerified: payload.email_verified === true,
      name: payload.name ?? null,
    }
  }
}
