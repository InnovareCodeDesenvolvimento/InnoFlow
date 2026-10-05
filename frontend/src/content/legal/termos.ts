import type { LegalDocumentContent } from "./types"

/**
 * Termos de Uso. MINUTA ESTRUTURAL: as seções e a descrição do que o produto FAZ hoje estão corretas (conferidas com o app); a redação jurídica definitiva (limitação de
 * responsabilidade, foro, direito de arrependimento, idade mínima) será escrita pela Alexandria e revisada pelo dono/advogado. Ver `types.ts` para as regras do conteúdo.
 */
export const TERMOS: LegalDocumentContent = {
  id: "termos",
  shortTitle: "Termos de Uso",
  title: "Termos de Uso",
  summary: "As regras para usar o InnoFlow: conta, recargas, pagamento, saldo e encerramento.",
  status: "draft",
  sections: [
    {
      id: "o-servico",
      title: "O que é o InnoFlow",
      paragraphs: [
        "O InnoFlow é uma plataforma para encontrar eletropostos, iniciar e acompanhar a recarga do seu veículo elétrico pelo celular (por QR code ou pelo aplicativo) e pagar pelo que consumiu.",
        "Ao criar uma conta ou usar o aplicativo, você declara que leu estes Termos e a Política de Privacidade e concorda com eles.",
      ],
      reviewNote: "Confirmar a razão social do fornecedor e a idade mínima para usar o serviço.",
    },
    {
      id: "sua-conta",
      title: "Sua conta",
      paragraphs: [
        "Você cria a conta com nome, e-mail e senha, ou entra com a sua conta Google. Os dados informados precisam ser verdadeiros e você é responsável por mantê-los atualizados.",
        "A senha é pessoal. Não a compartilhe: tudo o que for feito com a sua conta é de sua responsabilidade, e você pode trocar a senha a qualquer momento em Meu perfil.",
        "O pagamento com cartão só fica disponível para contas com identidade verificada pelo login com o Google.",
      ],
    },
    {
      id: "recargas-e-pagamento",
      title: "Recargas e pagamento",
      paragraphs: [
        "A tarifa de cada carregador é mostrada antes de você iniciar a recarga. O valor final depende da energia entregue e das regras da tarifa vigente no momento.",
        "Você pode pagar com o saldo da sua carteira (recarregado por Pix) ou com cartão salvo, quando disponível. Se uma recarga terminar com saldo insuficiente, o valor que faltou fica registrado como dívida em aberto na sua carteira, e novas recargas só são liberadas depois de quitá-la.",
        "Os dados do cartão são processados diretamente pela operadora de pagamento. O InnoFlow guarda apenas a bandeira, os quatro últimos dígitos, a validade e um identificador (token) que não permite usar o cartão fora da plataforma.",
      ],
    },
    {
      id: "saldo-e-devolucao",
      title: "Saldo da carteira e devolução",
      paragraphs: [
        "O saldo da carteira é um crédito para pagar recargas na rede InnoFlow. Ele aparece no extrato, com cada lançamento (recargas, créditos por Pix e ajustes).",
        "Ao excluir a conta, o saldo que restar é devolvido por Pix, em até 30 dias, para a chave que você informar no pedido de exclusão.",
      ],
      reviewNote: "Confirmar com o dono as regras de validade do saldo e de estorno fora da exclusão de conta.",
    },
    {
      id: "uso-adequado",
      title: "Uso adequado",
      paragraphs: ["Ao usar o InnoFlow você se compromete a:"],
      items: [
        "usar os carregadores conforme as instruções do local e do equipamento;",
        "não tentar acessar contas de outras pessoas nem burlar a cobrança ou os limites de segurança;",
        "não usar o serviço para fins ilícitos nem de forma que prejudique a rede de carregadores ou outros motoristas.",
      ],
      closing: ["Podemos limitar ou suspender contas que descumpram estas regras, avisando você quando possível."],
    },
    {
      id: "disponibilidade",
      title: "Disponibilidade e mudanças",
      paragraphs: [
        "Fazemos o possível para manter o serviço no ar, mas carregadores, redes e meios de pagamento podem ficar indisponíveis. Quando isso acontecer, mostramos o estado no aplicativo.",
        "Podemos atualizar estes Termos. Cada versão tem um identificador, e o que você aceitou fica registrado com a data. Quando houver uma versão nova, o aplicativo pede um novo aceite.",
      ],
      reviewNote: "Redigir limitação de responsabilidade e regras de indisponibilidade.",
    },
    {
      id: "encerramento",
      title: "Encerramento da conta",
      paragraphs: [
        "Você pode excluir a sua conta quando quiser, em Meu perfil > Privacidade e dados. A exclusão é definitiva. Não é possível excluir com recarga ou pagamento em andamento nem com dívida em aberto.",
        "O que é apagado e o que é mantido por obrigação legal está descrito na Política de Privacidade.",
      ],
    },
    {
      id: "contato",
      title: "Contato e foro",
      paragraphs: ["Dúvidas sobre estes Termos podem ser enviadas pelos canais de atendimento abaixo."],
      showCompany: true,
      reviewNote: "Definir o foro e o canal de atendimento (Decreto 7.962/2013 exige identificação do fornecedor e canal visíveis).",
    },
  ],
}
