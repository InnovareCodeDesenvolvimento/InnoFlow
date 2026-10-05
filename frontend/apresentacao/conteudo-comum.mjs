/** Textos que aparecem nos dois PDFs (mesmo conteúdo). Tudo aqui foi conferido contra o código; nada afirma produção nem integração validada. */

export const DATA = "05 de outubro de 2026"

/** Roteiro de "Próximas etapas" definido pelo dono. Sem datas e sem prazos. `destaque` = etapa que afeta o motorista (marcada só no PDF do motorista). */
export const ETAPAS = [
  {
    titulo: "Implantação do ambiente de produção",
    texto: "Publicação dos serviços (aplicativo do motorista, painel administrativo, API e gateway de carregadores), banco de dados, domínio próprio e HTTPS; troca das credenciais de teste por credenciais definitivas.",
    destaque: true,
  },
  {
    titulo: "Conexão do primeiro carregador real",
    texto: "Conexão segura (TLS), cadastro do equipamento no painel, configuração no carregador e roteiro de aceitação com o fabricante: conexão, início e parada de recarga e queda de energia.",
    destaque: true,
  },
  {
    titulo: "Homologação de pagamentos",
    texto: "Testes no ambiente de homologação da operadora (Pix e cartão), conferência dos retornos reais e, depois, prova controlada com valor baixo, conciliada com o extrato.",
    destaque: true,
  },
  {
    titulo: "Revisão final de segurança e operação",
    texto: "Nova rodada de revisão antes da abertura, alertas operacionais e rotinas de monitoramento e backup.",
    destaque: false,
  },
  {
    titulo: "Piloto e abertura ao público",
    texto: "Operação assistida com um grupo de motoristas, ajustes finos e liberação gradual.",
    destaque: true,
  },
]

export const DEPENDENCIAS = [
  "Definição do carregador e do local do piloto, com acesso ao fabricante.",
  "Credenciais de homologação e de produção do meio de pagamento.",
  "Domínio e acesso ao DNS.",
  "Aprovação dos textos e da identidade visual final.",
]

export const NOTA_DEPENDENCIAS = "Este documento não assume prazos: as datas serão combinadas conforme essas definições."
