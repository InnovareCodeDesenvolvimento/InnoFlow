# Contrato da API: Dados da empresa e versões dos Termos (Admin)

Contrato LITERAL das rotas `/api/admin/company-profile` e do que mudou em `GET /api/public/legal`. **Fonte da verdade do backend:** `backend/src/api/routes/companyProfile.routes.ts`, `backend/src/api/schemas/companyProfile.schema.ts`, `backend/src/services/legal/perfilEmpresaDto.ts` e `backend/src/services/legal/atualizarPerfilEmpresa.ts`. Os tipos abaixo **não estão** em `frontend/src/types/api.ts` (a Lyra copia de lá para lá, sem renomear; o tipo `PublicLegalConfig` existente só ganha os 4 campos opcionais marcados abaixo).

**Por quê:** o dono NÃO quer variáveis de ambiente para os dados da empresa; cadastra tudo por esta tela. O **painel manda**; as envs `LEGAL_*` são só a reserva (enquanto nada foi salvo). Não há segredo aqui (tudo aparece na página pública), então **não há step-up de senha** — em compensação o PUT é auditado e a mudança de versão exige confirmação explícita.

Todas as rotas: `Authorization: Bearer <jwt>`, **ADMIN** (OPERATOR e DRIVER recebem `403 FORBIDDEN`; sem token `401`). Erros no envelope da casa: `{ error: string, code: string, details?: ... }`.

## Rotas

| Método e caminho | Para quê | Limite |
|---|---|---|
| `GET /api/admin/company-profile` | Dados vigentes + de onde vêm (painel ou env) + versões | `adminRateLimit` geral |
| `PUT /api/admin/company-profile` | Salva (parcial). Responde com o mesmo corpo do GET | 10/min por ADMIN (conta os 400 também) |
| `GET /api/public/legal` | (existente, público) agora lê o painel; `Cache-Control: public, max-age=30` | `publicRateLimit` |

## Tipos (copiar para `frontend/src/types/api.ts`)

```ts
/** `GET /api/admin/company-profile` e resposta do `PUT`. Nada aqui é segredo: tudo volta em claro. */
export interface CompanyProfileDTO {
  /**
   * `db` = o painel já assumiu os dados da empresa (a env deixa de valer para eles); `env` = nada salvo ainda, valem as variáveis `LEGAL_*` do deploy (mostre como "valores iniciais do
   * deploy — salve para assumir"). Vale só para os DADOS DA EMPRESA; as versões têm fonte própria (`versions.*Source`).
   */
  source: 'db' | 'env'
  /** O que o dono DIGITOU (razão social verdadeira, sem o fallback para fantasia que a página pública usa). Vazio = `null`. */
  profile: {
    legalName: string | null // razão social
    tradeName: string | null // nome fantasia
    cnpj: string | null // formatado "00.000.000/0000-00" (o alfanumérico usa a mesma máscara); o PUT aceita com ou sem pontuação
    supportEmail: string | null
    supportPhone: string | null
    address: string | null // uma linha
    website: string | null // sempre http(s) completo, ex.: "https://www.suaempresa.com.br"
    dpoName: string | null // encarregado (DPO)
    dpoEmail: string | null
  }
  versions: {
    /** Versões VIGENTES agora (o que o front manda em `acceptedTermsVersion`). */
    termsVersion: string
    privacyVersion: string
    /** `db` = definida no painel; `env` = vale a variável do deploy (ou o padrão do código). */
    termsSource: 'db' | 'env'
    privacySource: 'db' | 'env'
    /** A versão que passa a valer se o campo do painel for limpo (`null`). Útil para o botão "voltar ao padrão do deploy". */
    envTermsVersion: string
    envPrivacyVersion: string
  }
  /** Campos da ENV com valor inválido (ficam vazios na página pública). Só aparece com `source: 'env'`; ex.: `['dpoEmail']`. */
  invalidEnvFields: string[]
  updatedAt: string | null // ISO; null = nunca salvo no painel
}

/**
 * `PUT /api/admin/company-profile`. TODOS os campos são opcionais, mas ao menos um (além de `confirmVersionChange`) é obrigatório.
 * Campo AUSENTE = não mexer. `null` ou texto vazio ("   ") = LIMPAR o campo. Campo desconhecido = 400.
 * Os valores são normalizados no servidor (CNPJ sem pontuação no banco, e-mail em minúsculas, site canônico, quebra de linha vira espaço).
 */
export interface UpdateCompanyProfileRequest {
  legalName?: string | null // até 160
  tradeName?: string | null // até 120
  /** Numérico ou alfanumérico (vigente desde jul/2026), com ou sem pontuação; dígitos verificadores conferidos. */
  cnpj?: string | null
  supportEmail?: string | null // e-mail válido, até 180
  /** Números, espaço, `+ ( ) . -`; 8 a 30 caracteres e ao menos 8 dígitos. */
  supportPhone?: string | null
  address?: string | null // até 300, uma linha
  /** http(s); sem esquema ("suaempresa.com.br") assume https; sem usuário/senha embutidos; até 200. `javascript:` e afins são recusados. */
  website?: string | null
  dpoName?: string | null // até 120
  dpoEmail?: string | null
  /** Até 32 caracteres: letras, números, ponto, hífen e sublinhado (ex.: "2026-10-06"). `null` = volta a valer a da env. */
  termsVersion?: string | null
  privacyVersion?: string | null
  /**
   * OBRIGATÓRIO `true` quando o PUT MUDA a versão EFETIVA dos Termos ou da Privacidade (compara o valor efetivo antes e depois: repetir a versão que já vale, ou trocar `null` por um
   * valor igual ao que a env já dava, NÃO é mudança). Mudar a versão faz TODOS os motoristas voltarem a `upToDate=false`. Sem isso: 409 `VERSION_CHANGE_NOT_CONFIRMED` e NADA é gravado
   * (nem os outros campos do mesmo PUT). Sobrando num PUT sem mudança de versão é inofensivo.
   */
  confirmVersionChange?: boolean
}

export type CompanyProfileErrorCode =
  | 'VALIDATION_ERROR' // 400 — details: [{ path: 'cnpj' | 'supportEmail' | ..., message: string PT-BR }]; nada gravado
  | 'VERSION_CHANGE_NOT_CONFIRMED' // 409 — details: [VersionChangeDetail]
  | 'RATE_LIMITED' // 429 — 10 PUTs/min por ADMIN
  | 'LEGAL_SETTINGS_UNAVAILABLE' // 503 — não deu para ler/gravar no banco

/** `details[0]` do 409 `VERSION_CHANGE_NOT_CONFIRMED`: mostre num diálogo "isto obriga N motoristas a aceitar de novo" e reenvie o MESMO PUT com `confirmVersionChange: true`. */
export interface VersionChangeDetail {
  field: 'confirmVersionChange'
  reason: 'REQUIRED_TRUE'
  currentTermsVersion: string
  currentPrivacyVersion: string
  newTermsVersion: string
  newPrivacyVersion: string
  /** Quantos motoristas (contas ativas) vão precisar aceitar de novo. */
  driversAffected: number
}

/** `GET /api/public/legal` — `PublicLegalConfig` existente, com 4 campos NOVOS em `company` (opcionais para quem lê; o servidor sempre os manda, `null` quando vazios). */
export interface PublicLegalConfig {
  termsVersion: string
  privacyVersion: string
  company: {
    /** Razão social (ou o nome fantasia, na falta dela). */
    name: string | null
    cnpj: string | null // formatado
    supportEmail: string | null
    supportPhone: string | null
    dpoEmail: string | null
    tradeName?: string | null // NOVO
    address?: string | null // NOVO
    website?: string | null // NOVO — já é uma URL http(s) segura para virar link
    dpoName?: string | null // NOVO — a LGPD (art. 41, §1º) manda divulgar a identidade e o contato do encarregado
  }
}
```

## Comportamentos que a tela precisa respeitar

1. **Ordem de erros do PUT:** 429 limite → 400 validação (`details[].path` aponta o campo; mensagens em PT-BR prontas para exibir) → 409 `VERSION_CHANGE_NOT_CONFIRMED` → 503. Nada é gravado em nenhum erro.
2. **Limpar um campo:** enviar `null` (ou texto vazio). Campo que a tela não quer alterar: **não enviar a chave** (mande só o que mudou, ou o formulário inteiro — dá igual, o resultado é o mesmo).
3. **Primeira gravação "importa" a env.** Se o deploy já tinha `LEGAL_*` preenchidas e o dono salva só um campo, o servidor copia para o painel o que a env informava (razão social, CNPJ, e-mail/telefone de suporte, e-mail do DPO) — nada some da página pública. Depois, o painel manda em tudo: campo apagado fica vazio. Com `source: 'env'` mostre um aviso "estes são os valores do deploy; salve para passar a gerenciá-los aqui".
4. **Versões dos documentos são um ato deliberado:** mudar `termsVersion`/`privacyVersion` obriga todos os motoristas a aceitar de novo (modal de reaceite no próximo acesso; cadastro novo só vale com a versão nova). A tela deve apresentar isso como uma ação à parte, com diálogo de confirmação ("Isto obriga N motoristas a aceitar os termos novamente") e só então enviar `confirmVersionChange: true`. Troque a versão **no mesmo momento** em que o texto novo vai ao ar.
5. **Efeito:** a API que grava enxerga a mudança na hora; o worker (rodapé dos e-mails ao motorista) e outras réplicas em até ~30 s. `GET /api/public/legal` tem cache de 30 s no navegador/CDN.
6. **Quem usa estes dados:** a rota pública (rodapé, `/termos`, `/privacidade`), o rodapé dos e-mails ao motorista (razão social, CNPJ, endereço, suporte) e o aceite dos termos (versão vigente). A tela de Admin > Comunicação usa o `supportEmail` só como sugestão para receber os relatórios do DMARC.
7. **Auditoria:** cada PUT gera UMA linha `UPDATE` / `CompanyProfile` (`actionDetail: 'company_profile'`, ou `'company_profile:legal_version_changed'` quando muda a versão). Razão social, fantasia, CNPJ, site e versões aparecem com antes/depois; e-mail e telefone de suporte, endereço e encarregado (nome e e-mail) aparecem só como `{ changed: true }`.
8. **CNPJ alfanumérico:** o campo de CNPJ não pode ser só numérico na tela (aceite letras A-Z/0-9 nos 12 primeiros caracteres; os 2 últimos são dígitos).

## Exemplos

`PUT` mínimo (só o telefone):

```json
{ "supportPhone": "(11) 4000-0000" }
```

`PUT` completo:

```json
{
  "legalName": "InnoFlow Mobilidade Ltda",
  "tradeName": "InnoFlow",
  "cnpj": "11.222.333/0001-81",
  "supportEmail": "suporte@innoflow.com.br",
  "supportPhone": "(11) 4000-0000",
  "address": "Rua das Flores, 100 - São Paulo/SP",
  "website": "www.innoflow.com.br",
  "dpoName": "Maria Encarregada",
  "dpoEmail": "dpo@innoflow.com.br"
}
```

`PUT` que muda a versão (2 passos): o 1º, sem `confirmVersionChange`, responde

```json
{ "error": "Mudar a versão dos Termos ou da Política de Privacidade obriga todos os motoristas a aceitar de novo no próximo acesso. Confirme para continuar.", "code": "VERSION_CHANGE_NOT_CONFIRMED", "details": [ { "field": "confirmVersionChange", "reason": "REQUIRED_TRUE", "currentTermsVersion": "2026-10-05", "currentPrivacyVersion": "2026-10-05", "newTermsVersion": "2026-10-06", "newPrivacyVersion": "2026-10-05", "driversAffected": 128 } ] }
```

e o 2º, com `{ "termsVersion": "2026-10-06", "confirmVersionChange": true }`, devolve `200` com `versions.termsVersion: "2026-10-06"` e `versions.termsSource: "db"`.
