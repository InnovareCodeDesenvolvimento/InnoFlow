/**
 * Rotas públicas dos documentos legais. Módulo minúsculo e SEM o texto dos documentos (`content/legal`) de propósito: rodapés, cadastro e re-aceite só precisam do
 * endereço, e importar o texto levaria o conteúdo inteiro para o chunk deles (a landing, em especial).
 */
export const LEGAL_PATHS = { termos: "/termos", privacidade: "/privacidade" } as const
