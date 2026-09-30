/**
 * Ator sentinela para linhas de `AuditLog` geradas por processo automático
 * (worker), sem usuário humano por trás — F5, decisão §5 da Nova
 * (`decisoes-f5-pagamento-cielo.md`): `actorRole='SYSTEM'` nunca é role de
 * um `User` de verdade (enum separado `AuditActorRole`), mas
 * `actorUserId`/`actorEmail`/`actorName` continuam NOT NULL no schema — o
 * worker usa este id/e-mail fixo para o ator nunca aparecer "vazio" no log.
 */
export const SYSTEM_ACTOR = {
  userId: 'system',
  email: 'system@innoelektron',
  name: 'Sistema (worker de pagamentos)',
} as const
