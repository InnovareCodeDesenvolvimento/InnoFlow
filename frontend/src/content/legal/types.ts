/**
 * Estrutura do conteúdo dos documentos legais (Termos de Uso e Política de Privacidade). O TEXTO mora nos arquivos `termos.ts` e `privacidade.ts` (um bloco de dados por
 * documento), separado da tela (`components/legal/LegalDocument.tsx`): quem redige o texto definitivo (Alexandria, revisado pelo dono e por um advogado) edita SÓ esses
 * dois arquivos, sem tocar em componente.
 *
 * Regras do conteúdo:
 *  - o texto é CORRIDO e em parágrafos curtos (`paragraphs`), com listas (`items`) quando há enumeração. Nada de HTML: a tela escapa tudo.
 *  - `showCompany: true` marca a seção que mostra os dados da empresa (vindos de `GET /api/public/legal`; o que estiver vazio NÃO aparece).
 *  - `reviewNote` é uma nota INTERNA (para quem revisa o texto): só aparece em modo dev/mock, nunca em produção.
 *  - mudar o texto de um documento exige subir a versão vigente (`LEGAL_TERMS_VERSION` / `LEGAL_PRIVACY_VERSION` no backend) no MESMO deploy: é a versão que o servidor grava como prova do aceite.
 */
export interface LegalSection {
  /** Âncora estável (`#id`) e chave da lista "Neste documento". */
  id: string
  title: string
  paragraphs: string[]
  items?: string[]
  /** Parágrafos depois da lista (opcional). */
  closing?: string[]
  /** Mostra o bloco "Responsável" com os dados da empresa que o dono já informou. */
  showCompany?: boolean
  /** Nota interna para a revisão jurídica (só em dev/mock). */
  reviewNote?: string
}

export interface LegalDocumentContent {
  id: "termos" | "privacidade"
  /** Título curto (item de menu/rodapé) e título completo da página. */
  shortTitle: string
  title: string
  /** Frase da faixa-título. */
  summary: string
  /** `draft` = minuta que ainda não passou pela revisão do dono/advogado. Hoje só aparece em dev/mock. */
  status: "draft" | "reviewed"
  sections: LegalSection[]
}
