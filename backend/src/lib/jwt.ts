import jwt from 'jsonwebtoken'
import { env } from './env'
import type { AuthPayload } from '../api/middleware/auth'

export function issueToken(user: { id: string; role: AuthPayload['role']; operatorId: string | null }): string {
  const payload: AuthPayload = { userId: user.id, role: user.role, operatorId: user.operatorId }
  const options: jwt.SignOptions = {
    algorithm: 'HS256',
    // @types/jsonwebtoken tipa `expiresIn` como um union literal específico
    // (`StringValue` do pacote `ms`), não `string` genérico — JWT_EXPIRES_IN
    // vem validado por Zod (env.ts) mas como string livre; o cast é seguro
    // porque `jwt.sign` valida o formato em runtime de qualquer forma.
    expiresIn: env.JWT_EXPIRES_IN as jwt.SignOptions['expiresIn'],
  }
  return jwt.sign(payload, env.JWT_SECRET, options)
}
