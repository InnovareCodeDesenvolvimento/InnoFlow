/**
 * Textos comuns sobre a CHAVE DOS SEGREDOS do servidor (decisão do dono, 05/10/2026): a chave que cifra os segredos salvos (cartões, gateway, SMTP/Evolution, destino do backup,
 * chave Pix de devolução) é DERIVADA do `JWT_SECRET` do servidor. `PAYMENT_SECRETS_KEY` virou um override OPCIONAL: os códigos de erro `PAYMENT_SECRETS_KEY_MISSING` /
 * `SECRETS_KEY_MISSING` e o item de prontidão `PAYMENT_SECRETS_KEY` mantêm o NOME, mas hoje só aparecem se o servidor tiver um override INVÁLIDO (ou sem `JWT_SECRET`).
 * Nenhuma tela manda criar variável: o ajuste é do administrador do servidor.
 */

/** Rótulo humano do item de prontidão `PAYMENT_SECRETS_KEY` e do banner "servidor sem chave". */
export const SECRETS_KEY_LABEL = "Chave de segredos do servidor"

/** Causa e saída para quem cuida do servidor (503 `…SECRETS_KEY_MISSING`). Sem jargão de variável além do que o administrador precisa conferir. */
export const SECRETS_KEY_UNAVAILABLE_TEXT =
  "A chave de segredos do servidor está inválida ou indisponível; peça ao administrador do servidor para conferir a configuração (JWT_SECRET e, se existir, PAYMENT_SECRETS_KEY)."

/** Erro de campo: digitou um segredo, mas o servidor não tem como cifrá-lo. */
export const SECRETS_KEY_FIELD_MESSAGE = "A chave de segredos do servidor está indisponível: não dá para guardar este segredo."
