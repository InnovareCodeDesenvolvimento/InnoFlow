# Contraste AA — estado atual (axe-core `color-contrast`)

Gerado por `scripts/relatorio-contraste.mjs` a partir de `npm run test:contraste`. 105 medições (rota × viewport).

- Nós **reprovados**: 0 · nós **aprovados**: 3753 · nós **que o axe NÃO conseguiu avaliar** (fundo em degradê/imagem/vidro): 898.
- **Garante:** nenhum texto avaliado pelo axe, fora dos reprovados abaixo, tem razão < 4,5:1 (3:1 para texto grande). **Não garante:** os `incompletos` (principalmente a landing escura e o vidro) não foram avaliados.

## Combinações reprovadas (agrupadas)

| Cores (fg sobre bg) · fonte · razão | Nós | Rotas |
|---|---:|---|

## Por classe de cor de texto (extraída do HTML do nó)

| Classe | Nós | Razão (mín–máx) | Rotas |
|---|---:|---|---|

## Nós que o axe NÃO conseguiu avaliar (`incomplete`) — por motivo

| Motivo (messageKey do axe) | Nós | Onde (rota: nós, as 6 maiores) |
|---|---:|---|
| bgGradient | 449 | pub-landing: 124, pub-rota-inexistente: 124, pwa-inicio: 19, pwa-travado-sessao-faulted: 16, pwa-carteira-adicionar: 15, pwa-mapa: 15 |
| pseudoContent | 312 | pub-landing: 156, pub-rota-inexistente: 156 |
| bgOverlap | 98 | pub-landing: 47, pub-rota-inexistente: 47, adm-dashboard: 4 |
| shortTextContent | 16 | pwa-mapa: 10, pwa-carteira: 3, pwa-travado-historico: 3 |
| elmPartiallyObscured | 10 | pwa-mapa: 5, pub-qr-carregador: 2, adm-gateway-pagamento: 1, auth-cadastro: 1, pub-qr-conector: 1 |
| sem-motivo | 6 | adm-auditoria: 3, adm-movimento-diario: 1, adm-pagamentos: 1, adm-sessoes: 1 |
| elmPartiallyObscuring | 6 | auth-cadastro: 2, pub-landing: 1, pub-qr-carregador: 1, pub-qr-conector: 1, pub-rota-inexistente: 1 |
| nonBmp | 1 | pwa-mapa: 1 |

## Por rota × viewport (reprovados / incompletos)

| Rota | 375 | 768 | 1440 |
|---|---:|---:|---:|
| adm-auditoria | 0 / 1 | 0 / 1 | 0 / 1 |
| adm-auth-tokens | 0 / 0 | 0 / 0 | 0 / 0 |
| adm-carteiras | 0 / 0 | 0 / 0 | 0 / 0 |
| adm-charge-points | 0 / 0 | 0 / 0 | 0 / 0 |
| adm-connectors | 0 / 0 | 0 / 0 | 0 / 0 |
| adm-dashboard | 0 / 1 | 0 / 3 | 0 / 3 |
| adm-dialogo-novo-site | 0 / 0 | 0 / 0 | 0 / 0 |
| adm-faturamento | 0 / 1 | 0 / 1 | 0 / 1 |
| adm-financeiro | 0 / 1 | 0 / 1 | 0 / 1 |
| adm-gateway-pagamento | 0 / 1 | 0 / 0 | 0 / 0 |
| adm-movimento-diario | 0 / 1 | 0 / 1 | 0 / 1 |
| adm-pagamentos | 0 / 1 | 0 / 0 | 0 / 0 |
| adm-sessoes | 0 / 1 | 0 / 0 | 0 / 0 |
| adm-sites | 0 / 0 | 0 / 0 | 0 / 0 |
| adm-tariffs | 0 / 0 | 0 / 0 | 0 / 0 |
| auth-cadastro | 0 / 4 | 0 / 3 | 0 / 3 |
| auth-login | 0 / 0 | 0 / 0 | 0 / 10 |
| pub-cartao-isolado-sem-opener | 0 / 0 | 0 / 0 | 0 / 0 |
| pub-eletropostos | 0 / 0 | 0 / 0 | 0 / 0 |
| pub-landing | 0 / 106 | 0 / 104 | 0 / 118 |
| pub-qr-carregador | 0 / 4 | 0 / 3 | 0 / 3 |
| pub-qr-conector | 0 / 4 | 0 / 4 | 0 / 4 |
| pub-rota-inexistente | 0 / 106 | 0 / 104 | 0 / 118 |
| pwa-carteira | 0 / 0 | 0 / 0 | 0 / 17 |
| pwa-carteira-adicionar | 0 / 0 | 0 / 0 | 0 / 15 |
| pwa-cartoes | 0 / 0 | 0 / 0 | 0 / 12 |
| pwa-historico-vazio | 0 / 0 | 0 / 0 | 0 / 10 |
| pwa-inicio | 0 / 0 | 0 / 0 | 0 / 19 |
| pwa-mapa | 0 / 5 | 0 / 0 | 0 / 26 |
| pwa-recibo-fechada-pelo-servidor | 0 / 1 | 0 / 1 | 0 / 12 |
| pwa-recibo-stop-nao-confirmado-cartao | 0 / 0 | 0 / 0 | 0 / 12 |
| pwa-recibo-stop-nao-confirmado-carteira | 0 / 0 | 0 / 0 | 0 / 11 |
| pwa-sessao-vazia | 0 / 0 | 0 / 0 | 0 / 9 |
| pwa-travado-historico | 0 / 0 | 0 / 0 | 0 / 12 |
| pwa-travado-sessao-faulted | 0 / 2 | 0 / 2 | 0 / 12 |
