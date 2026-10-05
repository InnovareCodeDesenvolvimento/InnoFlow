/**
 * Teste de PONTA A PONTA dos avisos ao dono (N-7): dispara UM alerta de teste (`alerts_test`, severidade INFO) FORÇANDO o envio por todos os canais
 * configurados (ignora severidade mínima, dedupe e teto por hora), para o dono conferir se o e-mail e o WhatsApp realmente chegam depois de configurar.
 *
 * Uso (no terminal do serviço `api` no EasyPanel, com as envs ALERT_* configuradas):
 *   npm run alerts:test
 *
 * Não imprime segredo: só quais canais estão ativos, o resultado de cada um (ok / motivo curto da falha) e os problemas de configuração.
 * Código de saída: 0 = todos os canais ativos enviaram; 1 = algum canal falhou; 2 = nenhum canal configurado.
 * Usa a configuração EFETIVA (a do PAINEL ADMIN manda, as envs ALERT_* são a reserva — a mesma que os avisos reais usam), então precisa do banco (DATABASE_URL, já presente no serviço). Banco
 * indisponível => só as envs. O alerta de teste vive só neste processo (dedupe em memória; não toca o Redis).
 */
import 'dotenv/config'
import { MemoriaDedupeStore } from '../src/core/alertas/dedupe'
import { ALERTA_DE_TESTE } from '../src/core/alertas/severidade'
import { criarCanalEmail, criarCanalWhatsapp, type CanalDeAlerta } from '../src/lib/alertas/canais'
import { algumCanalAtivo } from '../src/lib/alertas/config'
import { Notificador } from '../src/lib/alertas/notificador'
import { prisma } from '../src/lib/prisma'
import { getConfigComunicacao } from '../src/services/comunicacao/configComunicacao'

type Resultado = { canal: string; ok: boolean; motivo?: string }

function medir(canal: CanalDeAlerta, resultados: Resultado[]): CanalDeAlerta {
  return {
    nome: canal.nome,
    minSeveridade: canal.minSeveridade,
    async enviar(evento) {
      try {
        await canal.enviar(evento)
        resultados.push({ canal: canal.nome, ok: true })
      } catch (err) {
        // `FalhaDeCanal.motivo` é seguro (código/status, nunca credencial). Qualquer outro erro: só o nome.
        const motivo = (err as { motivo?: unknown } | null)?.motivo
        resultados.push({ canal: canal.nome, ok: false, motivo: typeof motivo === 'string' ? motivo : err instanceof Error ? err.name : 'erro' })
        throw err
      }
    },
  }
}

async function main(): Promise<number> {
  const efetiva = await getConfigComunicacao()
  const config = efetiva.config
  if (efetiva.leituraFalhou) console.warn('AVISO: nao consegui ler a configuracao do painel no banco — testando so com as variaveis de ambiente (reserva).')
  console.log(`Configuracao: ${efetiva.source === 'database' ? 'PAINEL (banco)' : 'variaveis de ambiente'} (e-mail: ${efetiva.fontes.email}, whatsapp: ${efetiva.fontes.whatsapp})`)
  for (const aviso of config.avisos) console.warn(`AVISO de configuracao: ${aviso}`)
  if (!algumCanalAtivo(config)) {
    console.error('Nenhum canal de aviso ativo. Configure no painel admin (Comunicacao) ou pelas variaveis ALERT_* — veja a secao "Alertas ao dono" em docs/DEPLOY-EASYPANEL.md.')
    return 2
  }

  const resultados: Resultado[] = []
  const canais: CanalDeAlerta[] = []
  if (config.email) canais.push(medir(criarCanalEmail(config.email), resultados))
  if (config.whatsapp) canais.push(medir(criarCanalWhatsapp(config.whatsapp), resultados))
  console.log(`Canais ativos: ${canais.map((c) => c.nome).join(', ')} (ambiente: ${config.ambiente}, servico: ${config.servico})`)
  if (config.email) console.log(`  e-mail: ${config.email.para.length} destinatario(s) via ${config.email.host}:${config.email.porta}`)
  if (config.whatsapp) console.log(`  whatsapp: provedor ${config.whatsapp.provedor}, ${config.whatsapp.para.length} numero(s)`)

  const notificador = new Notificador({
    config,
    canais,
    store: new MemoriaDedupeStore(),
    log: () => {}, // o resultado de cada canal já é medido acima; o motivo da falha vai no relatório
  })
  const destino = notificador.notificar({
    alerta: ALERTA_DE_TESTE,
    nivelPino: 30,
    mensagem: 'Alerta de TESTE do InnoFlow (npm run alerts:test). Se voce recebeu isto, o canal esta funcionando.',
    dados: { motivo: 'teste_manual' },
    forcar: true,
  })
  if (destino !== 'enfileirado') {
    console.error(`O alerta de teste nao foi enfileirado (${destino}).`)
    return 1
  }
  await notificador.aguardarOcioso(20_000)

  let falhou = false
  for (const canal of canais) {
    const r = resultados.find((x) => x.canal === canal.nome)
    if (!r) {
      console.error(`  ${canal.nome}: SEM RESPOSTA (prazo estourado) — confira host/porta/rede`)
      falhou = true
    } else if (r.ok) {
      console.log(`  ${canal.nome}: ENVIADO (confira a caixa de entrada / o WhatsApp; o provedor aceitou a mensagem)`)
    } else {
      console.error(`  ${canal.nome}: FALHOU — ${r.motivo}`)
      falhou = true
    }
  }
  return falhou ? 1 : 0
}

main()
  .then((codigo) => {
    process.exitCode = codigo
  })
  .catch((err: unknown) => {
    console.error(`Falha: ${err instanceof Error ? err.name : 'erro desconhecido'}`)
    process.exitCode = 2
  })
  .finally(async () => {
    await prisma.$disconnect().catch(() => {})
    process.exit(process.exitCode ?? 0)
  })
