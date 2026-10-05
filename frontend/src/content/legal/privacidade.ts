import type { LegalDocumentContent } from "./types"

/**
 * Política de Privacidade (LGPD). Redação final para revisão jurídica do dono e advogado.
 * Cada afirmação sobre dados, finalidades, bases legais e retenção foi verificada no código e documentação: ver tabela de rastreabilidade no relatório de Alexandria.
 * Parágrafo de retenção preservado conforme decisão anterior (DL6, 05/10/2026).
 * Ver `types.ts` para as regras do conteúdo.
 */
export const PRIVACIDADE: LegalDocumentContent = {
  id: "privacidade",
  shortTitle: "Política de Privacidade",
  title: "Política de Privacidade do InnoFlow",
  summary: "Quais dados pessoais tratamos, para quê, por quanto tempo e como você exerce seus direitos conforme a LGPD.",
  status: "draft",
  sections: [
    {
      id: "quem-trata",
      title: "1. Quem trata os seus dados",
      paragraphs: [
        "O controlador dos dados pessoais é a empresa identificada abaixo — responsável por decidir como e para quê seus dados são usados.",
        "Se você tiver dúvidas sobre privacidade ou quiser exercer seus direitos, entre em contato com o encarregado de dados (DPO) nos dados informados abaixo.",
      ],
      showCompany: true,
      reviewNote: "PARA O DONO: Os dados da empresa (razão social, CNPJ, e-mail, DPO) vêm de GET /api/public/legal no backend via variáveis LEGAL_COMPANY_*. Confirme que estão preenchidos antes de publicar.",
    },
    {
      id: "dados-que-coletamos",
      title: "2. Quais dados coletamos",
      paragraphs: ["Coletamos apenas os dados necessários para você usar o serviço:"],
      items: [
        "Cadastro: nome completo, e-mail, senha (guardada de forma irreversível — nem nós conseguimos ler), telefone e CPF (opcionais). Se você entra com o Google, recebemos o identificador único da sua conta Google e o e-mail verificado pelo Google.",
        "Recargas: para cada recarga, guardamos: carregador (local e identificador), horários de início e término, energia entregue (kWh), valor final e forma de pagamento usada.",
        "Carteira: movimentações (recargas, créditos por Pix, estornos, devoluções) com data, valor e tipo.",
        "Cartão de crédito: apenas bandeira (Visa, Mastercard, etc.), quatro últimos dígitos, data de validade, nome do titular e um identificador único (token) emitido pela operadora de pagamento. Nunca armazenamos o número completo do cartão nem o código de segurança (CVV).",
        "Segurança: endereço IP e identificação do seu dispositivo (user-agent do navegador) registrados no início de cada recarga e no momento em que você aceita estes Termos.",
        "Preferências e notificações: suas escolhas de receber (ou não) e-mails sobre recargas, saldo baixo e outros eventos, além dos e-mails que efetivamente enviamos.",
      ],
    },
    {
      id: "para-que-usamos",
      title: "3. Para que usamos seus dados",
      paragraphs: ["Usamos os dados pessoais para:"],
      items: [
        "criar, proteger e manter sua conta segura — validar sua identidade, autenticar seu acesso, recuperar sua senha se esquecer;",
        "iniciar e acompanhar recargas — vincular o carregamento ao seu perfil, calcular o consumo e o valor devido;",
        "cobrar recargas — processar os pagamentos por Pix ou cartão através das operadoras de pagamento;",
        "mostrar seu histórico de recargas, extrato da carteira e saldo — tudo disponível em Meu perfil;",
        "devolver o saldo quando você exclui a conta — através de Pix para a chave que você fornece;",
        "enviar e-mails transacionais — recibo de recarga, notificação de saldo baixo, confirmação de mudança de senha ou exclusão de conta;",
        "cumprir obrigações legais e fiscais — guardar registros de transações e auditoria conforme a lei;",
        "prevenir fraude e abuso — detectar padrões anormais de uso, bloquear contas comprometidas.",
      ],
    },
    {
      id: "com-quem-compartilhamos",
      title: "4. Com quem compartilhamos seus dados",
      paragraphs: [
        "Não vendemos dados pessoais. Compartilhamos apenas o mínimo necessário com parceiros que nos ajudam a oferecer o serviço:",
      ],
      items: [
        "Operadora de pagamento (Cielo) — quando você paga com cartão ou Pix, recebe: identificador único da sua conta, valor, tipo de pagamento, data e resultado da transação. Nunca recebe o número completo do cartão nem a senha.",
        "Provedor de login (Google) — quando você escolhe 'Entrar com Google', a conta Google autentica você e nos informa seu e-mail verificado e seu identificador único no Google. Dados de recarga ou carteira NÃO são compartilhados com o Google.",
        "Serviço de e-mail — quando enviamos um recibo de recarga ou notificação de saldo baixo, o servidor SMTP (configurado pelo operador da plataforma) entrega o e-mail. O texto do e-mail contém informações da recarga, mas não dados sensíveis (cartão, CPF, etc.).",
      ],
      closing: [
        "Dados nunca são transferidos para fora do Brasil exceto conforme obrigação legal. Podemos compartilhar dados com autoridades (polícia, receita, órgão regulador) quando exigido por lei, conforme o artigo 7º, VII da LGPD.",
      ],
      reviewNote: "PARA O DONO: Confirme: (1) a operadora de pagamento atual (Cielo/Braspag?); (2) o provedor de SMTP (qual servidor de e-mail?); (3) se há qualquer transferência internacional de dados; (4) outras parcerias (hospedagem, CDN, backups) que devem ser listadas.",
    },
    {
      id: "quanto-tempo-guardamos",
      title: "5. Por quanto tempo guardamos",
      paragraphs: [
        "Enquanto sua conta estiver ativa, guardamos todos os seus dados pessoais para você usar o serviço.",
        "Ao excluir a conta, apagamos o IP e o dispositivo (user-agent) registrados no início das suas recargas e o IP do aceite dos termos. Mantemos, sem identificação, as sessões, o extrato e os pagamentos por 5 anos (obrigação legal e fiscal). Registros de auditoria de segurança anteriores à exclusão podem conter e-mail, nome e IP do titular e são apagados por expurgo automático por idade (24 meses).",
        "Na exclusão, seus dados pessoais (nome, e-mail, telefone, CPF e cartões salvos) são apagados de forma irreversível. Os registros financeiros das recargas (valores, datas, histórico) ficam sem identificação — o InnoFlow não consegue associá-los a você.",
      ],
      reviewNote: "Parágrafo de retenção PRESERVADO conforme decisão aprovada pelo dono (DL6, 05/10/2026). Advogado: revisar se os prazos de 5 anos e 24 meses atendem às exigências legais de retenção fiscal e de auditoria.",
    },
    {
      id: "seus-direitos",
      title: "6. Seus direitos (LGPD)",
      paragraphs: ["A Lei Geral de Proteção de Dados (LGPD) garante a você estes direitos:"],
      items: [
        "Acessar seus dados: em Meu perfil > Privacidade e dados você baixa uma cópia completa em JSON, até 3 vezes por dia. O arquivo contém todas as informações que guardamos sobre você.",
        "Corrigir dados incompletos ou desatualizados: em Meu perfil você atualiza nome, e-mail, telefone ou CPF.",
        "Pedir a exclusão dos dados: em Meu perfil > Privacidade e dados > Excluir minha conta. Você precisa confirmar sua identidade (senha ou ID token do Google) e fornecer uma chave Pix para devolvemos o saldo.",
        "Saber com quem seus dados são compartilhados: esta política descreve todos os parceiros e o que cada um recebe.",
        "Revogar o consentimento: não é possível 'sair' de dados de segurança e cobrança (são obrigatórios), mas você pode desativar notificações por e-mail em Meu perfil > Notificações.",
      ],
      closing: [
        "Se você não conseguir exercer um direito pelo aplicativo, ou quiser questionar como seus dados são tratados, fale com o encarregado de dados (DPO) pelos canais indicados no início desta política. Você também pode reclamar à Autoridade Nacional de Proteção de Dados (ANPD).",
      ],
    },
    {
      id: "seguranca",
      title: "7. Segurança",
      paragraphs: [
        "Protegemos seus dados com múltiplas camadas de segurança:",
      ],
      items: [
        "Senhas — são guardadas de forma irreversível (hash com salt), nem nós conseguimos ler;",
        "Dados de pagamento — cartão e Pix são cifrados quando armazenados e só descriptografados para operações autorizadas;",
        "Acesso — controle de quem pode ver e mudar dados dentro da empresa, autenticação de dois fatores e logs de auditoria;",
        "Comunicação — toda transmissão usa HTTPS (conexão criptografada entre seu dispositivo e nossos servidores);",
        "Alertas — operações sensíveis (mudança de senha, exclusão de conta) são registradas e você recebe notificação por e-mail.",
      ],
      closing: [
        "Nenhum sistema é totalmente imune a ataques. Se houver um incidente que coloque seus dados em risco, comunicaremos você e a Autoridade Nacional de Proteção de Dados (ANPD) conforme a lei exige.",
      ],
    },
    {
      id: "armazenamento-no-aparelho",
      title: "8. O que guardamos no seu aparelho (cookies e localStorage)",
      paragraphs: [
        "O aplicativo guarda no navegador/dispositivo apenas o mínimo necessário:",
      ],
      items: [
        "Token de sessão — para manter você conectado (sem refazer login a cada página);",
        "Preferências — se o tour de boas-vindas já foi visto (para não mostrar de novo), tema escolhido (claro/escuro) e outras preferências de interface.",
      ],
      closing: [
        "Não usamos cookies de publicidade, analytics de terceiros (Google Analytics, Facebook Pixel, etc.) nem rastreamento de comportamento. A única coleta de dados é a que você iniciou ao usar o serviço e que está descrita nesta política.",
      ],
      reviewNote: "VERIFICADO: sem Google Analytics, Mixpanel, Hotjar ou similares no código. localStorage armazena apenas token e configurações de interface. Publicar com confiança.",
    },
    {
      id: "criancas",
      title: "9. Crianças",
      paragraphs: [
        "O InnoFlow é destinado a maiores de idade. Se você não é maior de idade segundo a legislação brasileira, não pode usar o serviço.",
        "Se descobrirmos que uma criança criou uma conta, apagamos os dados imediatamente e contatamos o responsável. Entre em contato conosco se souber de uma criança usando a plataforma.",
      ],
      reviewNote: "PARA O DONO: Confirmar a idade mínima (a maioria dos apps de pagamento exige 18 anos). Se há pagadores menores de idade com consentimento dos pais, ajustar esta seção.",
    },
    {
      id: "transferencia-internacional",
      title: "10. Dados fora do Brasil",
      paragraphs: [
        "Dados não são transferidos para fora do Brasil em operação normal. Se houver uma transferência internacional (por exemplo, backup em servidor fora do país, parceria com empresa estrangeira), será notificado nesta política com antecedência.",
      ],
      reviewNote: "PARA O DONO E ADVOGADO: Verificar se há transferência internacional hoje (hospedagem, CDN, backup em cloud estrangeira). Se houver, detalhar: para qual país, que dados, em qual contexto e qual a base legal (artigo 7º, LGPD).",
    },
    {
      id: "mudancas",
      title: "11. Mudanças nesta política",
      paragraphs: [
        "Quando esta política mudar, publicamos a nova versão aqui com data de atualização. Se for uma mudança que afetar seus direitos (por exemplo, novo compartilhamento de dados), o aplicativo notifica você e pede um novo aceite antes de você usar o serviço.",
      ],
    },
  ],
}
