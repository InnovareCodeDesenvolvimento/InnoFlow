import type { LegalDocumentContent } from "./types"

/**
 * Política de Privacidade (LGPD). MINUTA ESTRUTURAL: a lista de dados, finalidades e prazos descreve o que o sistema faz hoje (conferido com o backend L1.4/L1.9). O parágrafo
 * de retenção em `quanto-tempo-guardamos` foi DEFINIDO pelo time e deve ser mantido como está. A redação jurídica definitiva é da Alexandria, com revisão do dono/advogado.
 */
export const PRIVACIDADE: LegalDocumentContent = {
  id: "privacidade",
  shortTitle: "Política de Privacidade",
  title: "Política de Privacidade",
  summary: "Quais dados pessoais tratamos, para quê, por quanto tempo e como você exerce seus direitos.",
  status: "draft",
  sections: [
    {
      id: "quem-trata",
      title: "Quem trata os seus dados",
      paragraphs: ["O controlador dos dados pessoais tratados pelo InnoFlow é a empresa identificada abaixo."],
      showCompany: true,
      reviewNote: "Dados da empresa (razão social, CNPJ, e-mail de suporte, encarregado/DPO) vêm do dono via variáveis LEGAL_* do backend.",
    },
    {
      id: "dados-que-coletamos",
      title: "Dados que coletamos",
      paragraphs: ["Tratamos apenas o que é necessário para o serviço funcionar:"],
      items: [
        "Cadastro: nome, e-mail, senha (guardada de forma irreversível) e, se você informar, telefone e CPF. Se você entra com o Google, recebemos o identificador da sua conta Google e o e-mail verificado.",
        "Recargas e carteira: sessões de recarga (carregador, horários, energia, valor), extrato da carteira, pagamentos por Pix e dívidas em aberto.",
        "Cartões salvos: bandeira, quatro últimos dígitos, validade, nome do titular e um identificador (token) emitido pela operadora. Nunca guardamos o número completo nem o código de segurança.",
        "Segurança: o endereço IP e o dispositivo (user-agent) registrados no início das suas recargas e o IP do aceite dos Termos.",
        "Preferências e avisos: suas escolhas de notificação e os e-mails que enviamos a você.",
      ],
    },
    {
      id: "para-que-usamos",
      title: "Para que usamos",
      paragraphs: ["Usamos os dados para:"],
      items: [
        "criar e proteger a sua conta e identificar você nas recargas;",
        "iniciar, acompanhar e cobrar as recargas, e mostrar o seu histórico e o seu saldo;",
        "processar pagamentos e devolver saldo quando você exclui a conta;",
        "enviar avisos sobre o serviço (por exemplo, recibo de recarga, saldo baixo e mudanças de senha);",
        "cumprir obrigações legais, fiscais e de prevenção a fraude.",
      ],
    },
    {
      id: "com-quem-compartilhamos",
      title: "Com quem compartilhamos",
      paragraphs: [
        "Não vendemos dados pessoais. Compartilhamos o mínimo necessário com a operadora de pagamento (para cobrar cartão e Pix), com o provedor de login do Google (quando você escolhe entrar por ele) e com o serviço de envio de e-mails. Também podemos informar dados a autoridades, quando a lei exigir.",
      ],
      reviewNote: "Listar os operadores/suboperadores reais (gateway de pagamento, hospedagem, e-mail) e transferências internacionais, se houver.",
    },
    {
      id: "quanto-tempo-guardamos",
      title: "Por quanto tempo guardamos",
      paragraphs: [
        "Mantemos os dados da sua conta enquanto ela existir. Ao excluir a conta, apagamos o IP e o dispositivo (user-agent) registrados no início das suas recargas e o IP do aceite dos termos. Mantemos, sem identificação, as sessões, o extrato e os pagamentos por 5 anos (obrigação legal e fiscal). Registros de auditoria de segurança anteriores à exclusão podem conter e-mail, nome e IP do titular e são apagados por expurgo automático por idade (24 meses).",
        "Na exclusão, os seus dados pessoais (nome, e-mail, telefone, CPF e cartões salvos) são apagados. Os registros financeiros das recargas (valores, datas, extrato) ficam sem identificação.",
      ],
    },
    {
      id: "seus-direitos",
      title: "Seus direitos",
      paragraphs: ["A LGPD garante a você, entre outros direitos:"],
      items: [
        "confirmar que tratamos seus dados e acessá-los: em Meu perfil > Privacidade e dados você baixa uma cópia em JSON, até 3 vezes por dia;",
        "corrigir dados incompletos ou desatualizados: em Meu perfil;",
        "pedir a eliminação dos dados pessoais: em Meu perfil > Privacidade e dados > Excluir minha conta;",
        "ter informação sobre com quem compartilhamos os dados e sobre as consequências de não consentir.",
      ],
      closing: ["Para exercer um direito que não esteja disponível no aplicativo, fale com o encarregado de dados pelos canais indicados no início desta política."],
    },
    {
      id: "seguranca",
      title: "Segurança",
      paragraphs: [
        "Protegemos os dados com controle de acesso, senhas guardadas de forma irreversível, cifragem de segredos e dados de pagamento e registro de operações sensíveis. Nenhum sistema é totalmente imune; se houver um incidente que possa afetar você, comunicaremos conforme a lei.",
      ],
    },
    {
      id: "armazenamento-no-aparelho",
      title: "O que guardamos no seu aparelho",
      paragraphs: [
        "O aplicativo guarda no navegador do seu aparelho o necessário para manter você conectado e lembrar preferências de tela (por exemplo, o tour de boas-vindas já visto). Não usamos cookies de publicidade.",
      ],
      reviewNote: "Confirmar a ausência de cookies/analytics de terceiros antes de publicar esta frase.",
    },
    {
      id: "mudancas",
      title: "Mudanças nesta política",
      paragraphs: ["Quando esta política mudar, publicamos a nova versão aqui e, se for uma mudança relevante, o aplicativo pede um novo aceite."],
    },
  ],
}
