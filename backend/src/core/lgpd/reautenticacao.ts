/**
 * Reautenticação OBRIGATÓRIA da exclusão de conta (L1.4): mesmo com JWT válido, quem rouba um token de 12 h não apaga a conta de ninguém sem saber a senha (ou, na conta só-Google,
 * sem ter um ID token novo do Google). Regras PURAS — qual prova pedir e se a identidade do Google é a da conta.
 *
 *  - conta COM senha: a senha é obrigatória (mesmo que o corpo também traga `googleCredential`: uma prova só, a mais forte e a que tem tranca por tentativas);
 *  - conta SEM senha (só-Google): `googleCredential`, e o `sub` verificado tem de ser o `googleSub` da conta (e o e-mail do Google verificado);
 *  - conta sem nenhum dos dois não deveria existir; se existir, não há como provar identidade -> recusa.
 */

export type MetodoDeReautenticacao = { metodo: 'SENHA' } | { metodo: 'GOOGLE' } | { metodo: 'NENHUM'; erro: 'CURRENT_PASSWORD_REQUIRED' | 'GOOGLE_CREDENTIAL_REQUIRED' | 'SEM_METODO_DE_PROVA' }

export function escolherMetodoDeReautenticacao(conta: { temSenha: boolean; temGoogle: boolean }, corpo: { senhaInformada: boolean; googleInformado: boolean }): MetodoDeReautenticacao {
  if (conta.temSenha) return corpo.senhaInformada ? { metodo: 'SENHA' } : { metodo: 'NENHUM', erro: 'CURRENT_PASSWORD_REQUIRED' }
  if (conta.temGoogle) return corpo.googleInformado ? { metodo: 'GOOGLE' } : { metodo: 'NENHUM', erro: 'GOOGLE_CREDENTIAL_REQUIRED' }
  return { metodo: 'NENHUM', erro: 'SEM_METODO_DE_PROVA' }
}

export function identidadeGoogleConfere(identidade: { sub: string; emailVerified: boolean }, googleSubDaConta: string): boolean {
  return identidade.emailVerified && identidade.sub === googleSubDaConta
}
