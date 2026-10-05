/**
 * Simulação de "o dono trocou o JWT_SECRET" / "o override PAYMENT_SECRETS_KEY ficou inválido" nos testes de integração.
 *
 * MUDANÇA DELIBERADA (05/10/2026, chave dos segredos DERIVADA do JWT_SECRET, como no InnoChat): antes, "a chave de cifragem trocou/sumiu" era simulado mexendo em `PAYMENT_SECRETS_KEY`. Agora a chave
 * vem do `JWT_SECRET` — e trocar o JWT_SECRET também INVALIDA os tokens de sessão já emitidos (é o comportamento real: todos precisam logar de novo). Por isso quem troca precisa REEMITIR o token
 * do admin que vai continuar chamando a API (`reemitirToken`).
 */

export const JWT_SECRET_TROCADO = 'jwt-secret-TROCADO-pelo-dono-do-sistema-0123456789-xyz'

/** Troca o JWT_SECRET do `env` já carregado (como se a variável tivesse mudado no EasyPanel). Devolve a função que restaura o valor de antes. */
export function trocarJwtSecret(env: Record<string, unknown>, novo: string = JWT_SECRET_TROCADO): () => void {
  const original = env.JWT_SECRET
  env.JWT_SECRET = novo
  return () => {
    env.JWT_SECRET = original
  }
}

/** Override `PAYMENT_SECRETS_KEY` DEFINIDO MAS INVÁLIDO (não é base64 de 32 bytes) => chave-mestra indisponível (fail-closed). É o que sobrou do antigo "chave ausente => 503 *_SECRETS_KEY_MISSING". */
export const OVERRIDE_INVALIDO = 'isto-nao-e-uma-chave-base64-de-32-bytes'
