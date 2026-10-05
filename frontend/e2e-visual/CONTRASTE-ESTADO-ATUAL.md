# Contraste AA — estado atual (axe-core `color-contrast`)

Gerado por `scripts/relatorio-contraste.mjs` a partir de `npm run test:contraste`. 105 medições (rota × viewport).

- Nós **reprovados**: 0 · nós **aprovados**: 3257 · nós **que o axe NÃO conseguiu avaliar** (fundo em degradê/imagem/vidro): 937.
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
| bgGradient | 666 | pub-landing: 124, adm-dashboard: 39, pwa-travado-sessao-faulted: 33, adm-movimento-diario: 25, pub-eletropostos: 22, pwa-inicio: 22 |
| pseudoContent | 156 | pub-landing: 156 |
| bgOverlap | 66 | pub-landing: 47, pub-eletropostos: 14, adm-dashboard: 5 |
| shortTextContent | 24 | pwa-mapa: 10, adm-auth-tokens: 1, adm-carteiras: 1, adm-charge-points: 1, adm-connectors: 1, adm-dashboard: 1 |
| elmPartiallyObscuring | 12 | auth-cadastro: 3, auth-login: 3, pub-qr-carregador: 3, pub-qr-conector: 2, pub-landing: 1 |
| sem-motivo | 6 | adm-auditoria: 3, adm-movimento-diario: 1, adm-pagamentos: 1, adm-sessoes: 1 |
| elmPartiallyObscured | 5 | pwa-mapa: 5 |
| imgNode | 1 | pwa-inicio: 1 |
| nonBmp | 1 | pwa-mapa: 1 |

## Por rota × viewport (reprovados / incompletos)

| Rota | 375 | 768 | 1440 |
|---|---:|---:|---:|
| adm-auditoria | 0 / 1 | 0 / 1 | 0 / 1 |
| adm-auth-tokens | 0 / 0 | 0 / 0 | 0 / 22 |
| adm-carteiras | 0 / 0 | 0 / 0 | 0 / 22 |
| adm-charge-points | 0 / 0 | 0 / 0 | 0 / 22 |
| adm-connectors | 0 / 0 | 0 / 0 | 0 / 22 |
| adm-dashboard | 0 / 6 | 0 / 6 | 0 / 33 |
| adm-dialogo-novo-site | 0 / 0 | 0 / 0 | 0 / 22 |
| adm-faturamento | 0 / 0 | 0 / 0 | 0 / 22 |
| adm-financeiro | 0 / 0 | 0 / 0 | 0 / 22 |
| adm-gateway-pagamento | 0 / 0 | 0 / 0 | 0 / 22 |
| adm-movimento-diario | 0 / 1 | 0 / 2 | 0 / 24 |
| adm-pagamentos | 0 / 1 | 0 / 0 | 0 / 22 |
| adm-sessoes | 0 / 1 | 0 / 0 | 0 / 22 |
| adm-sites | 0 / 0 | 0 / 0 | 0 / 22 |
| adm-tariffs | 0 / 0 | 0 / 0 | 0 / 22 |
| auth-cadastro | 0 / 3 | 0 / 3 | 0 / 8 |
| auth-login | 0 / 3 | 0 / 3 | 0 / 8 |
| pub-cartao-isolado-sem-opener | 0 / 1 | 0 / 1 | 0 / 1 |
| pub-eletropostos | 0 / 10 | 0 / 14 | 0 / 12 |
| pub-landing | 0 / 106 | 0 / 104 | 0 / 118 |
| pub-qr-carregador | 0 / 5 | 0 / 4 | 0 / 3 |
| pub-qr-conector | 0 / 3 | 0 / 3 | 0 / 3 |
| pub-rota-inexistente | 0 / 4 | 0 / 4 | 0 / 4 |
| pwa-carteira | 0 / 3 | 0 / 3 | 0 / 3 |
| pwa-carteira-adicionar | 0 / 3 | 0 / 3 | 0 / 3 |
| pwa-cartoes | 0 / 5 | 0 / 5 | 0 / 5 |
| pwa-historico-vazio | 0 / 3 | 0 / 3 | 0 / 3 |
| pwa-inicio | 0 / 11 | 0 / 6 | 0 / 6 |
| pwa-mapa | 0 / 7 | 0 / 2 | 0 / 13 |
| pwa-recibo-fechada-pelo-servidor | 0 / 4 | 0 / 4 | 0 / 4 |
| pwa-recibo-stop-nao-confirmado-cartao | 0 / 5 | 0 / 5 | 0 / 5 |
| pwa-recibo-stop-nao-confirmado-carteira | 0 / 4 | 0 / 4 | 0 / 4 |
| pwa-sessao-vazia | 0 / 2 | 0 / 2 | 0 / 2 |
| pwa-travado-historico | 0 / 1 | 0 / 1 | 0 / 1 |
| pwa-travado-sessao-faulted | 0 / 11 | 0 / 11 | 0 / 11 |
