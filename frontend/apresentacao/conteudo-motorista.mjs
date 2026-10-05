/**
 * PDF do MOTORISTA — app (PWA) e páginas públicas. Os textos entre aspas reproduzem o que a tela mostra; o resto descreve o que o fluxo faz,
 * conferido nas telas (frontend/src/pages/App, Public, Auth) e nos recortes capturados.
 */
import { DATA, DEPENDENCIAS, ETAPAS, NOTA_DEPENDENCIAS } from "./conteudo-comum.mjs"

const secoes = [
  { id: "descobrir", titulo: "Descobrir", subtitulo: "Do primeiro contato ao eletroposto livre mais próximo, antes mesmo de criar conta." },
  { id: "entrar", titulo: "Entrar", subtitulo: "Criar a conta e acessar o app, sem burocracia." },
  { id: "recarregar", titulo: "Recarregar", subtitulo: "Do QR do carregador ao recibo: tarifa à vista, acompanhamento ao vivo e parada quando quiser." },
  { id: "carteira", titulo: "Carteira e pagamentos", subtitulo: "Saldo recarregado por Pix e cartões cadastrados uma única vez." },
  { id: "historico", titulo: "Histórico e imprevistos", subtitulo: "Todas as recargas ao alcance e explicações claras quando algo foge do previsto." },
]

const slides = [
  { tipo: "capa", eyebrow: "Apresentação do sistema", titulo: "App do <em>motorista</em>", subtitulo: "Da descoberta do eletroposto ao recibo, tudo pelo celular.", data: DATA },
  {
    tipo: "visao",
    eyebrow: "Visão geral",
    titulo: "A experiência em cinco momentos",
    lead: "O app instalável no celular (PWA) e as páginas públicas que o motorista vê antes e durante a recarga.",
    areas: [
      { titulo: "Descobrir", texto: "Ver o que está livre agora, em lista ou mapa.", telas: ["Landing", "Eletropostos", "Mapa"] },
      { titulo: "Entrar", texto: "Conta criada em um formulário curto.", telas: ["Cadastro e login"] },
      { titulo: "Recarregar", texto: "Do QR ao recibo, com a tarifa à vista.", telas: ["QR do carregador", "Iniciar recarga", "Sessão ao vivo", "Parar e recibo"] },
      { titulo: "Carteira e pagamentos", texto: "Saldo por Pix e cartões salvos.", telas: ["Início e carteira", "Adicionar saldo (Pix)", "Cartões"] },
      { titulo: "Histórico e imprevistos", texto: "Recibos e estados de falha explicados.", telas: ["Histórico", "Estados de falha"] },
    ],
    aviso: "Todas as telas deste documento foram capturadas do ambiente de demonstração, com dados fictícios. Os pagamentos são simulados: nenhuma cobrança real é feita.",
  },
  {
    tipo: "jornada",
    secaoNome: "Jornada",
    eyebrow: "A jornada em ordem de uso",
    titulo: "De escanear o QR ao recibo",
    lead: "As cinco telas que o motorista percorre em uma recarga, na ordem em que aparecem.",
    passos: [
      { img: "mot-qr-tarifa", legenda: "Escaneia o QR", sub: "Vê a tarifa antes de entrar", alt: "Página do QR do carregador com a tarifa de R$ 1,99 por kWh" },
      { img: "mot-fluxo-iniciar", legenda: "Confere e inicia", sub: "Tarifa e saldo à vista", alt: "Tela com a tarifa, o saldo e o botão Iniciar recarga" },
      { img: "mot-sessao-ao-vivo", legenda: "Acompanha ao vivo", sub: "Energia, valor e tempo", alt: "Sessão ao vivo com energia, valor e tempo decorrido" },
      { img: "mot-sessao-parar", legenda: "Para quando quiser", sub: "Com confirmação", alt: "Diálogo de confirmação para parar a recarga" },
      { img: "mot-recibo", legenda: "Recebe o recibo", sub: "Custo detalhado", alt: "Recibo da recarga concluída com o detalhamento do custo" },
    ],
  },

  // ------------------------------------------------------------------ 1. Descobrir
  {
    tipo: "tela",
    secao: "descobrir",
    rotulo: "Landing",
    resumo: "A porta de entrada, no computador e no celular",
    eyebrow: "Descobrir",
    titulo: "Landing",
    lead: "A página pública que apresenta a proposta e leva direto ao que importa.",
    pontos: [
      "Mensagem direta: recarregue seu elétrico sem complicação.",
      "Dois caminhos à vista: “Ver eletropostos” e “Criar conta”.",
      "Três garantias: ver o que está livre, conferir a tarifa antes de iniciar e acompanhar a recarga pelo celular.",
      "Funciona no computador e no celular.",
    ],
    midia: { tipo: "janela+fone", img: "mot-landing-desktop", titulo: "InnoFlow — Página inicial", fone: "mot-landing", foneAlt: "Landing no celular" },
  },
  {
    tipo: "tela",
    secao: "descobrir",
    rotulo: "Eletropostos",
    resumo: "Lista pública com disponibilidade agora",
    eyebrow: "Descobrir",
    titulo: "Eletropostos",
    lead: "Veja o que está livre agora, atualizado em tempo real, sem precisar de conta.",
    pontos: [
      "Cada local mostra quantos conectores estão livres, com tipo e potência.",
      "Selos claros: “Livre agora” ou “Tudo ocupado”.",
      "Botão “Como chegar” em cada eletroposto.",
    ],
    midia: { tipo: "fones", itens: [{ img: "mot-eletropostos", alt: "Lista pública de eletropostos com disponibilidade" }] },
  },
  {
    tipo: "tela",
    secao: "descobrir",
    rotulo: "Mapa",
    resumo: "O eletroposto mais próximo, no mapa",
    eyebrow: "Descobrir",
    titulo: "Mapa",
    lead: "Os eletropostos da rede no mapa, com a disponibilidade em cada pino.",
    pontos: [
      "O número no pino é a quantidade de conectores livres; verde tem vaga, laranja está ocupado, cinza está fora do ar.",
      "Ordenação por mais próximos, mais conectores ou nome; alterna entre lista e mapa.",
      "Privacidade: a posição exata fica só no aparelho; só uma região aproximada (cerca de 11 km) é enviada para buscar.",
    ],
    midia: { tipo: "fones", itens: [{ img: "mot-mapa", alt: "Mapa de eletropostos com pinos de disponibilidade" }] },
  },

  // ------------------------------------------------------------------ 2. Entrar
  {
    tipo: "tela",
    secao: "entrar",
    rotulo: "Cadastro e login",
    resumo: "Conta criada em um formulário curto",
    eyebrow: "Entrar",
    titulo: "Cadastro e login",
    lead: "Criar a conta leva um formulário curto; quem já tem conta entra com e-mail e senha.",
    pontos: ["Cadastro com nome, e-mail e senha de no mínimo 8 caracteres; o telefone é opcional.", "Login com e-mail e senha.", "Atalhos entre as duas telas: “Cadastre-se” e “Entrar”."],
    midia: {
      tipo: "fones",
      itens: [
        { img: "mot-cadastro", legenda: "Criar conta", alt: "Tela de cadastro do motorista" },
        { img: "mot-login", legenda: "Entrar", alt: "Tela de login do motorista" },
      ],
    },
  },

  // ------------------------------------------------------------------ 3. Recarregar
  {
    tipo: "tela",
    secao: "recarregar",
    rotulo: "QR do carregador",
    resumo: "Conectores e tarifa, antes de entrar",
    eyebrow: "Recarregar",
    titulo: "QR do carregador",
    lead: "Escanear o QR colado no carregador abre uma página pública pronta para a recarga.",
    pontos: [
      "Quando há mais de um conector, o motorista escolhe o seu, com tipo, potência e disponibilidade.",
      "A tarifa aparece antes de qualquer cobrança: preço por kWh e cobrança mínima por sessão.",
      "Quem ainda não entrou vê “Entrar para carregar”.",
    ],
    midia: {
      tipo: "fones",
      seta: true,
      itens: [
        { img: "mot-qr-conectores", legenda: "Escolhe o conector", alt: "Página do QR com a lista de conectores do carregador" },
        { img: "mot-qr-tarifa", legenda: "Vê a tarifa", alt: "Página do conector com a tarifa por kWh e a cobrança mínima" },
      ],
    },
  },
  {
    tipo: "tela",
    secao: "recarregar",
    rotulo: "Iniciar recarga",
    resumo: "Saldo à vista e conexão com o carregador",
    eyebrow: "Recarregar",
    titulo: "Iniciar recarga",
    lead: "Logado, o motorista confere o saldo e inicia com um toque.",
    pontos: ["Tarifa, cobrança mínima e “Seu saldo” na mesma tela.", "Um botão “Iniciar recarga”, a ação principal da tela.", "Enquanto o comando chega ao carregador, o app avisa: “Conectando ao carregador…”."],
    midia: {
      tipo: "fones",
      seta: true,
      itens: [
        { img: "mot-fluxo-iniciar", legenda: "Inicia a recarga", alt: "Tela com tarifa, saldo e botão Iniciar recarga" },
        { img: "mot-sessao-conectando", legenda: "Conecta ao carregador", alt: "Tela Conectando ao carregador" },
      ],
    },
  },
  {
    tipo: "tela",
    secao: "recarregar",
    rotulo: "Sessão ao vivo",
    resumo: "Energia, valor e tempo em tempo real",
    eyebrow: "Recarregar",
    titulo: "Sessão ao vivo",
    lead: "A recarga acompanhada em tempo real, na palma da mão.",
    pontos: ["Energia entregue em kWh, valor parcial em reais e tempo decorrido.", "Potência e, quando o carregador informa, o nível da bateria.", "O botão vermelho “Parar recarga” fica sempre à vista."],
    midia: { tipo: "fones", itens: [{ img: "mot-sessao-ao-vivo", alt: "Sessão de recarga ao vivo" }] },
  },
  {
    tipo: "tela",
    secao: "recarregar",
    rotulo: "Parar e recibo",
    resumo: "Parada com confirmação e recibo detalhado",
    eyebrow: "Recarregar",
    titulo: "Parar e recibo",
    lead: "Parar pede confirmação; ao fim, o recibo mostra exatamente o que foi cobrado.",
    pontos: [
      "A confirmação explica: o carregador encerra a sessão e o valor consumido até ali é cobrado da carteira.",
      "O recibo traz início, fim, energia e tarifa, com o detalhamento do custo.",
      "O novo saldo da carteira aparece no próprio recibo.",
    ],
    midia: {
      tipo: "fones",
      seta: true,
      itens: [
        { img: "mot-sessao-parar", legenda: "Confirma a parada", alt: "Diálogo Parar a recarga agora" },
        { img: "mot-recibo", legenda: "Recebe o recibo", alt: "Recibo da recarga concluída" },
      ],
    },
  },

  // ------------------------------------------------------------------ 4. Carteira e pagamentos
  {
    tipo: "tela",
    secao: "carteira",
    rotulo: "Início e carteira",
    resumo: "Saldo, atalhos e extrato",
    eyebrow: "Carteira e pagamentos",
    titulo: "Início e carteira",
    lead: "O saldo sempre à vista, com os atalhos para recarregar e para o extrato.",
    pontos: [
      "Início: saldo, “Pronto para carregar?”, eletropostos perto de você e últimas recargas.",
      "Carteira: saldo disponível e extrato de lançamentos, como o débito de uma recarga.",
      "Atalhos para “Adicionar saldo” (Pix) e “Meus cartões”.",
    ],
    midia: {
      tipo: "fones",
      itens: [
        { img: "mot-inicio", legenda: "Início", alt: "Tela inicial do app com saldo e atalhos" },
        { img: "mot-carteira-apos", legenda: "Carteira", alt: "Carteira com saldo e extrato" },
      ],
    },
  },
  {
    tipo: "tela",
    secao: "carteira",
    rotulo: "Adicionar saldo (Pix)",
    resumo: "Valor, QR code e “copia e cola”",
    eyebrow: "Carteira e pagamentos",
    titulo: "Adicionar saldo",
    lead: "Recarregar a carteira por Pix: o saldo cai assim que o pagamento é confirmado.",
    pontos: [
      "Valores sugeridos (R$ 20, R$ 50 e R$ 100) ou outro valor, de R$ 10 a R$ 500.",
      "Pix com QR code e código “copia e cola”, válido por 30 minutos.",
      "A tela se atualiza sozinha quando o pagamento é confirmado.",
    ],
    nota: "No ambiente de demonstração o Pix é simulado: nenhuma cobrança real é feita.",
    midia: {
      tipo: "fones",
      seta: true,
      itens: [
        { img: "mot-adicionar-saldo", legenda: "Escolhe o valor", alt: "Tela Adicionar saldo com valores sugeridos" },
        { img: "mot-pix", legenda: "Paga com Pix", alt: "QR code e código copia e cola do Pix" },
      ],
    },
  },
  {
    tipo: "tela",
    secao: "carteira",
    rotulo: "Cartões",
    resumo: "Cadastro uma vez, direto na operadora",
    eyebrow: "Carteira e pagamentos",
    titulo: "Cartões",
    lead: "Cadastre o cartão uma vez e use com um toque nas próximas recargas.",
    pontos: [
      "O cadastro abre uma página isolada: “Seus dados vão direto para a operadora do cartão”.",
      "O InnoFlow nunca recebe o número do cartão nem o CVV.",
      "Depois de salvo, basta tocar em “Iniciar” nas próximas recargas.",
    ],
    nota: "Ambiente de demonstração: o cadastro de cartão não é enviado a uma operadora real.",
    midia: {
      tipo: "fones",
      seta: true,
      itens: [
        { img: "mot-cartoes", legenda: "Meus cartões", alt: "Tela Meus cartões sem nenhum cartão cadastrado" },
        { img: "mot-cartao-isolado", legenda: "Cadastro isolado", alt: "Página isolada de cadastro de cartão" },
      ],
    },
  },

  // ------------------------------------------------------------------ 5. Histórico e imprevistos
  {
    tipo: "tela",
    secao: "historico",
    rotulo: "Histórico",
    resumo: "Todas as recargas, com um toque para o recibo",
    eyebrow: "Histórico e imprevistos",
    titulo: "Histórico",
    lead: "Todas as recargas ao alcance, da mais recente para a mais antiga.",
    pontos: ["Cada recarga mostra eletroposto, status, data, energia e valor.", "Um toque abre o recibo completo.", "Recargas ainda em confirmação aparecem com o selo “Encerramento em confirmação”, explicado a seguir."],
    midia: { tipo: "fones", itens: [{ img: "mot-historico", alt: "Histórico de recargas do motorista" }] },
  },
  {
    tipo: "falhas",
    secao: "historico",
    rotulo: "Estados de falha",
    resumo: "Quando algo foge do previsto, o app explica",
    eyebrow: "Histórico e imprevistos",
    titulo: "Quando algo foge do previsto, o app explica",
    lead: "Falha do carregador ou parada ainda não confirmada: mensagens em linguagem simples, dizendo o que foi ou não cobrado.",
    itens: [
      { img: "mot-sessao-falha", legenda: "Falha informada", sub: "Pode encerrar a qualquer momento", alt: "Sessão com aviso de falha informada pelo carregador" },
      { img: "mot-recibo-nao-confirmado-carteira", legenda: "Parada em confirmação", sub: "Nada foi cobrado ainda", alt: "Recibo com encerramento em confirmação, pago com carteira" },
      { img: "mot-recibo-nao-confirmado-cartao", legenda: "Em confirmação (cartão)", sub: "A pré-autorização continua reservada", alt: "Recibo com encerramento em confirmação, pago com cartão" },
      { img: "mot-recibo-fechada-pelo-servidor", legenda: "Fechada pelo servidor", sub: "Cobra só o que foi medido", alt: "Recibo de recarga encerrada pelo servidor" },
    ],
  },

  // ------------------------------------------------------------------ encerramento
  {
    tipo: "entregue",
    eyebrow: "Encerramento",
    titulo: "O que está entregue",
    lead: "Fatos verificáveis no ambiente de demonstração mostrado neste documento.",
    blocos: [
      {
        titulo: "Descobrir e entrar",
        pontos: [
          "App instalável no celular (PWA), também acessível pelo navegador.",
          "Landing, lista pública de eletropostos e mapa com disponibilidade.",
          "Cadastro e login por e-mail e senha.",
        ],
      },
      {
        titulo: "Recarregar",
        pontos: [
          "QR do carregador com escolha do conector e tarifa à vista.",
          "Início, acompanhamento ao vivo e parada com confirmação.",
          "Recibo com custo detalhado e novo saldo.",
        ],
      },
      {
        titulo: "Carteira e histórico",
        pontos: [
          "Carteira com extrato e recarga de saldo por Pix (simulado).",
          "Cartões cadastrados em página isolada, sem passar pelo InnoFlow.",
          "Histórico de recargas e estados de falha explicados.",
        ],
      },
    ],
    numeros: [
      { valor: "5", rotulo: "momentos da jornada do motorista" },
      { valor: "2", rotulo: "meios de pagamento: Pix e cartão" },
      { valor: "4", rotulo: "situações de falha explicadas no app" },
      { valor: "1", rotulo: "app instalável no celular (PWA)" },
    ],
    aviso: "Ainda não realizado: conexão com um carregador real, homologação dos pagamentos e implantação em produção. Veja as próximas etapas.",
  },
  {
    tipo: "etapas",
    eyebrow: "Encerramento",
    titulo: "Próximas etapas",
    etapas: ETAPAS,
    dependencias: DEPENDENCIAS,
    notaDependencias: NOTA_DEPENDENCIAS,
  },
]

export default {
  id: "motorista",
  arquivo: "InnoFlow-Motorista",
  produto: "App do motorista",
  titulo: "InnoFlow — App do motorista (apresentação)",
  descricao: "Apresentação do app e das páginas públicas do motorista do InnoFlow. Ambiente de demonstração com dados fictícios.",
  secoes,
  slides,
}
