/**
 * Erros do backup como CÓDIGO (é o que vai para `BackupRun.errorCode`, para a resposta da API e para o alerta): nunca texto livre. O detalhe técnico (stderr do pg_dump, resposta do
 * destino) fica só no log do servidor, depois de passar por `limparTextoSensivel` — pode citar host/usuário do banco e do bucket.
 * Puro: sem env, sem logger.
 */

export const CODIGOS_DE_ERRO_DO_BACKUP = [
  'CONFIG', // destino incompleto / endereço recusado pela política anti-SSRF / DATABASE_URL ausente
  'CREDENTIAL', // o destino recusou a credencial
  'FOLDER', // bucket/pasta inexistente ou sem acesso
  'QUOTA', // sem espaço no destino
  'NETWORK', // rede/instabilidade do destino
  'OAUTH_DISCONNECTED', // Google: acesso revogado/expirado, reconectar
  'DUMP', // pg_dump/pg_restore falhou (cliente ausente, versão antiga, banco recusou)
  'DUMP_TIMEOUT', // pg_dump passou do prazo e foi morto
  'KEY', // chave do backup ausente/ilegível/diferente da do arquivo
  'SECRETS_KEY', // a chave-mestra (derivada do JWT_SECRET, ou o override PAYMENT_SECRETS_KEY) não decifra os segredos do destino: JWT_SECRET trocado
  'TOO_BIG', // arquivo maior que o limite do envio simples (5 GiB no S3)
  'NO_BACKUP', // o destino não tem nenhuma cópia (conferência)
  'VERIFY', // a conferência reprovou (cópia vazia, adulterada, sem marca, índice vazio)
  'CHECKSUM', // o SHA-256 do arquivo baixado não bate com o gravado no envio
  'BUSY', // já existe uma execução em andamento
  'INTERRUPTED', // o processo morreu no meio (fechado pelo agendador)
  'NOT_PICKED_UP', // pedido manual que o worker nunca pegou (worker fora do ar)
  'UNKNOWN',
] as const

export type CodigoDeErroDoBackup = (typeof CODIGOS_DE_ERRO_DO_BACKUP)[number]

export class ErroDeBackup extends Error {
  constructor(
    message: string,
    readonly codigo: CodigoDeErroDoBackup,
  ) {
    super(message)
    this.name = 'ErroDeBackup'
  }
}

export function ehCodigoDeErroDoBackup(valor: unknown): valor is CodigoDeErroDoBackup {
  return typeof valor === 'string' && (CODIGOS_DE_ERRO_DO_BACKUP as readonly string[]).includes(valor)
}

/** Texto para uma pessoa ler a partir do CÓDIGO (a tela e o alerta usam isto; nunca o stderr bruto). */
export const MENSAGEM_DO_ERRO: Readonly<Record<CodigoDeErroDoBackup, string>> = {
  CONFIG: 'O destino do backup está incompleto ou foi recusado. Abra Admin > Backup, complete os dados do destino e use Testar destino.',
  CREDENTIAL: 'O destino recusou a credencial. Confira a chave de acesso e o segredo (S3) ou conecte a conta Google de novo.',
  FOLDER: 'O bucket ou a pasta não existe ou não está acessível com esta credencial. Confira o nome e as permissões de gravar e apagar.',
  QUOTA: 'Não há espaço no destino. Libere espaço ou reduza a quantidade de cópias mantidas.',
  NETWORK: 'Falha de rede ao falar com o destino. O agendador tenta de novo; se repetir, trate como incidente: sem isso não há cópia nova do banco.',
  OAUTH_DISCONNECTED: 'A conta Google conectada não autoriza mais o backup (acesso revogado, senha trocada ou app do Google Cloud em modo de teste). Conecte de novo em Admin > Backup.',
  DUMP: 'O pg_dump não terminou. Confira se a imagem do worker tem o cliente do PostgreSQL (versão igual ou mais nova que a do servidor) e se DATABASE_URL está certa. O detalhe está no log do servidor.',
  DUMP_TIMEOUT: 'O pg_dump passou do prazo e foi interrompido. O detalhe está no log do servidor.',
  KEY: 'A chave de criptografia do backup está ausente, ilegível (a cópia dela guardada no sistema não abre mais se o JWT_SECRET mudou) ou é diferente da que cifrou a cópia. Gere a chave de novo em Admin > Backup e guarde o arquivo; as cópias antigas só abrem com a chave antiga.',
  SECRETS_KEY: 'O servidor não conseguiu decifrar os segredos do destino: o JWT_SECRET do ambiente mudou (a chave dos segredos salvos é derivada dele). Volte ao JWT_SECRET original ou cadastre o destino de novo em Admin > Backup.',
  TOO_BIG: 'O arquivo cifrado passa do limite do envio simples (5 GiB). É preciso envio em partes (multipart), que ainda não existe.',
  NO_BACKUP: 'O destino ainda não tem nenhuma cópia do backup. Use Fazer backup agora e confira de novo.',
  VERIFY: 'A conferência da cópia mais recente reprovou: o arquivo está vazio, adulterado, sem a marca do formato ou o índice do dump está vazio. Faça um backup novo e confira de novo.',
  CHECKSUM: 'O SHA-256 do arquivo baixado não bate com o gravado no envio: a cópia foi alterada ou corrompida no destino. Não restaure essa cópia.',
  BUSY: 'Já existe um backup ou uma conferência em andamento.',
  INTERRUPTED: 'A execução foi interrompida (o sistema reiniciou ou parou no meio da cópia).',
  NOT_PICKED_UP: 'O pedido não foi pego pelo worker. Confira se o serviço worker está no ar.',
  UNKNOWN: 'Erro inesperado. O detalhe está no log do servidor.',
}

export function mensagemDoErro(codigo: string | null): string | null {
  if (codigo === null) return null
  return ehCodigoDeErroDoBackup(codigo) ? MENSAGEM_DO_ERRO[codigo] : MENSAGEM_DO_ERRO.UNKNOWN
}
