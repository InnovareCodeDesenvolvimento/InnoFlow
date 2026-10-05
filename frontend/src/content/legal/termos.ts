import type { LegalDocumentContent } from "./types"

/**
 * Termos de Uso. Redação final para revisão jurídica do dono e advogado.
 * Cada afirmação sobre comportamento do sistema foi verificada no código: ver tabela de rastreabilidade no relatório de Alexandria.
 * Ver `types.ts` para as regras do conteúdo.
 */
export const TERMOS: LegalDocumentContent = {
  id: "termos",
  shortTitle: "Termos de Uso",
  title: "Termos de Uso do InnoFlow",
  summary: "As regras para usar o InnoFlow: conta, recargas, pagamento, saldo e encerramento.",
  status: "draft",
  sections: [
    {
      id: "o-servico",
      title: "1. O que é o InnoFlow",
      paragraphs: [
        "O InnoFlow é uma plataforma para encontrar eletropostos, iniciar e acompanhar a recarga do seu veículo elétrico pelo celular (por QR code ou pelo aplicativo) e pagar pelo que consumiu.",
        "Ao criar uma conta ou usar o aplicativo, você declara que leu estes Termos e a Política de Privacidade e concorda com eles.",
      ],
      reviewNote: "PARA O DONO: Confirmar: (1) razão social exata da empresa fornecedora, (2) idade mínima, (3) endereço comercial e foro competente (Decreto 7.962/2013 exige). A razão social e dados de contato virão de GET /api/public/legal.",
    },
    {
      id: "sua-conta",
      title: "2. Sua conta",
      paragraphs: [
        "Você cria a conta com nome, e-mail e senha, ou entra com a sua conta Google. Os dados informados precisam ser verdadeiros e você é responsável por mantê-los atualizados.",
        "A senha é pessoal. Não a compartilhe: tudo o que for feito com a sua conta é de sua responsabilidade. Você pode trocar a senha a qualquer momento em Meu perfil > Segurança.",
        "O pagamento com cartão de crédito só fica disponível para contas com identidade verificada pelo Google login.",
      ],
    },
    {
      id: "recargas-e-pagamento",
      title: "3. Recargas e formas de pagamento",
      paragraphs: [
        "A tarifa de cada carregador é mostrada antes de você iniciar a recarga. O valor final depende da energia entregue e das regras da tarifa vigente no momento.",
        "Você pode pagar com o saldo da sua carteira (recarregado por Pix) ou com cartão salvo. Se uma recarga terminar com saldo insuficiente, o valor que faltou fica registrado como dívida em aberto, e novas recargas só são liberadas depois de quitá-la.",
        "Pagamento por Pix: o código QR gerado vence em 30 minutos. Você pode ter apenas uma recarga Pix pendente por vez.",
        "Pagamento por cartão: os dados do cartão são processados diretamente pela operadora de pagamento (Cielo). O InnoFlow guarda apenas a bandeira, os quatro últimos dígitos, a data de validade e um identificador único (token) que não permite usar o cartão fora desta plataforma. A operadora de pagamento pede sua autorização antes de cada cobrança.",
      ],
    },
    {
      id: "saldo-e-devolucao",
      title: "4. Carteira e crédito",
      paragraphs: [
        "O saldo da carteira é um crédito para pagar recargas na rede InnoFlow. Ele aparece no extrato, com cada lançamento (recargas, créditos por Pix e ajustes).",
        "Você pode visualizar o saldo e o histórico completo em Carteira no aplicativo.",
        "Ao excluir a conta, o saldo que restar é devolvido por Pix, em até 30 dias, para a chave Pix que você informar no pedido de exclusão.",
      ],
      reviewNote: "PARA O DONO: Confirmar: (1) a chave Pix para devolução (pode ser CPF, CNPJ, e-mail, telefone ou aleatória); (2) se há limite de validade/expiração do saldo; (3) se há taxa ou regra especial para devolução.",
    },
    {
      id: "uso-adequado",
      title: "5. Uso adequado",
      paragraphs: ["Ao usar o InnoFlow você se compromete a:"],
      items: [
        "usar os carregadores conforme as instruções do local, do equipamento e da aplicação;",
        "não tentar acessar contas de outras pessoas, burlar a cobrança ou contornar os limites de segurança;",
        "não usar o serviço para fins ilícitos nem de forma que prejudique a rede de carregadores, os dados de outros usuários ou a disponibilidade do serviço.",
      ],
      closing: [
        "Podemos limitar, suspender ou encerrar contas que descumpram estas regras. Você pode questionar a suspensão pelos canais de atendimento abaixo.",
        "Se você notificar algo ilícito, como fraude ou uso indevido da rede, nos ajude entrando em contato pelos canais indicados no final deste documento.",
      ],
    },
    {
      id: "disponibilidade",
      title: "6. Disponibilidade e limitação de responsabilidade",
      paragraphs: [
        "Fazemos o possível para manter o serviço operacional 24 horas por dia, mas não podemos garantir disponibilidade contínua. Carregadores, redes de telecomunicações, serviços de pagamento e a plataforma podem ficar indisponíveis por manutenção, falhas técnicas ou circunstâncias fora do nosso controle. Quando isso acontecer, mostramos o estado no aplicativo.",
        "O InnoFlow é fornecido 'no estado em que se encontra', sem garantia expressa de resultados. Não somos responsáveis por danos diretos, indiretos, incidentais, especiais ou consequentes (incluindo perda de dados, lucros cessantes ou interrupção do negócio), mesmo se avisados da possibilidade de tais danos. Sua responsabilidade total conosco é limitada ao valor pago nos últimos 12 meses.",
        "Você é responsável por manter a segurança da sua conta (senha, telefone e dispositivo) e por qualquer atividade em sua conta. O InnoFlow não se responsabiliza por acesso não autorizado devido a seu descuido.",
      ],
      reviewNote: "PARA REVISÃO JURÍDICA: O texto de limitação segue padrão, mas precisa validação conforme lei aplicável (CDC, lei de e-commerce, contrato com pagador) e recomendação de advogado sobre ajustes. Manter as regras é obrigatório por lei de proteção ao consumidor.",
    },
    {
      id: "encerramento",
      title: "7. Exclusão da conta",
      paragraphs: [
        "Você pode excluir a sua conta a qualquer momento, em Meu perfil > Privacidade e dados > Excluir minha conta. A exclusão é permanente e irreversível.",
        "Não é possível excluir a conta se houver: (1) uma recarga em andamento, (2) um pagamento aguardando confirmação, ou (3) uma dívida em aberto na carteira.",
        "Para completar a exclusão, você precisa confirmar sua identidade com a senha (se cadastro com e-mail e senha) ou com o ID token do Google.",
        "Após a exclusão, seu nome, e-mail, telefone, CPF e cartões salvos são apagados de forma irreversível. Seus dados de recarga (consumo, horários, valores) são mantidos sem identificação por obrigação legal e fiscal. Leia a Política de Privacidade para detalhes completos.",
      ],
    },
    {
      id: "alteracoes",
      title: "8. Alterações dos Termos",
      paragraphs: [
        "Podemos atualizar estes Termos a qualquer momento. Cada versão tem um identificador (número de versão) e o que você aceitou fica registrado com a data.",
        "Quando uma mudança é substancial, o aplicativo notifica você e pede um novo aceite antes de usar o serviço. Mudanças menores (correção de erros, esclarecimento de redação) não exigem novo aceite.",
        "Se você continuar usando o serviço após notificado, significa que aceitou os Termos novos.",
      ],
    },
    {
      id: "contato",
      title: "9. Contato e foro",
      paragraphs: [
        "Dúvidas, reclamações ou sugestões sobre estes Termos devem ser enviadas pelos canais indicados abaixo. Responderemos em até 10 dias úteis.",
      ],
      showCompany: true,
      reviewNote: "PARA O DONO: Confirmar: (1) foro competente (local onde as ações serão julgadas); (2) canal de atendimento (e-mail, telefone, formulário web); (3) se inclui câmara de arbitragem ou resolução de disputas. Decreto 7.962/2013 exige que identidade e canais sejam claros.",
    },
  ],
}
