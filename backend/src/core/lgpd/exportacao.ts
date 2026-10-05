/**
 * Regras PURAS da exportação de dados do titular (L1.4, LGPD art. 18: acesso e portabilidade). O serviço (`services/lgpd/exportarDadosDoTitular.ts`) busca no banco;
 * aqui ficam só as transformações que decidem o que PODE sair e como.
 *
 * Princípio: lista BRANCA de campos (cada coleção é montada campo a campo no serviço) + estas máscaras. Nunca `...linhaDoBanco` — um campo novo no schema
 * (token, ciphertext, hash) não pode entrar na exportação por acidente.
 */

/** Máximo de linhas por coleção. Passou disso, a coleção sai TRUNCADA (mais recentes primeiro) e `limits.truncated` avisa — nunca uma resposta ilimitada. */
export const LIMITE_LINHAS_POR_COLECAO = 5000

/** Tamanho a partir do qual o plano manda virar job assíncrono com link por e-mail (docs/PLANO-FUNCIONALIDADES.md, L1.4): aqui só vira alerta no log. */
export const TAMANHO_ALERTA_BYTES = 5 * 1024 * 1024

/** Exportações por usuário por janela (contrato: 3 por dia). */
export const EXPORTACOES_POR_DIA = 3
export const JANELA_EXPORTACAO_SEGUNDOS = 24 * 60 * 60

/** `idTag` mascarado: sobram só os 2 primeiros e os 2 últimos caracteres (suficiente para o titular reconhecer o cartão RFID, inútil para usá-lo). */
export function mascararIdTag(idTag: string): string {
  if (idTag.length <= 4) return '*'.repeat(idTag.length)
  return `${idTag.slice(0, 2)}${'*'.repeat(idTag.length - 4)}${idTag.slice(-2)}`
}

/** `MM/AAAA` (como aparece no cartão). `null` se faltar mês ou ano. */
export function formatarValidade(mes: number | null, ano: number | null): string {
  if (mes == null || ano == null) return ''
  return `${String(mes).padStart(2, '0')}/${ano}`
}

/** `innoflow-meus-dados-AAAAMMDD.json` — a data é a do SERVIDOR em UTC (nome de arquivo, sem fuso do usuário). */
export function nomeDoArquivoDeExportacao(agora: Date): string {
  const y = agora.getUTCFullYear()
  const m = String(agora.getUTCMonth() + 1).padStart(2, '0')
  const d = String(agora.getUTCDate()).padStart(2, '0')
  return `innoflow-meus-dados-${y}${m}${d}.json`
}

/**
 * Rede de segurança do teste "nunca contém segredo": nomes de chave que NUNCA podem aparecer em qualquer nível do JSON exportado. O teste de integração varre o
 * resultado inteiro contra esta lista (e contra os valores reais plantados no banco).
 */
export const CHAVES_PROIBIDAS_NA_EXPORTACAO: readonly string[] = [
  'passwordHash',
  'googleSub',
  'cieloCardTokenCiphertext',
  'refundPixKeyCiphertext',
  'refundPixKey',
  'cieloPaymentId',
  'pixQrCode',
  'ciphertext',
  'token',
  'idTag',
]
