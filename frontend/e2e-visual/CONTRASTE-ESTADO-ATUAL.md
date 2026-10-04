# Contraste AA — estado atual (axe-core `color-contrast`)

Gerado por `scripts/relatorio-contraste.mjs` a partir de `npm run test:contraste`. 105 medições (rota × viewport).

- Nós **reprovados**: 445 · nós **aprovados**: 3308 · nós **que o axe NÃO conseguiu avaliar** (fundo em degradê/imagem/vidro): 898.
- **Garante:** nenhum texto avaliado pelo axe, fora dos reprovados abaixo, tem razão < 4,5:1 (3:1 para texto grande). **Não garante:** os `incompletos` (principalmente a landing escura e o vidro) não foram avaliados.

## Combinações reprovadas (agrupadas)

| Cores (fg sobre bg) · fonte · razão | Nós | Rotas |
|---|---:|---|
| #6b7280 sobre #f5f6f8 · 8.3pt (11px) / peso bold · razão 4.47 (mín 4.5) | 137 | adm-auth-tokens, adm-carteiras, adm-charge-points, adm-connectors, adm-dialogo-novo-site, adm-movimento-diario +4 |
| #6b7280 sobre #f3f4f6 · 8.3pt (11px) / peso bold · razão 4.39 (mín 4.5) | 69 | adm-connectors, pub-eletropostos, pwa-mapa |
| #62757f sobre #0e2a3a · 7.5pt (10px) / peso bold · razão 3.09 (mín 4.5) | 56 | adm-auth-tokens, adm-carteiras, adm-charge-points, adm-connectors, adm-dashboard, adm-dialogo-novo-site +8 |
| #717984 sobre #f5f6f8 · 7.5pt (10px) / peso bold · razão 4.07 (mín 4.5) | 39 | adm-auth-tokens, adm-carteiras, adm-charge-points, adm-connectors, adm-dashboard, adm-dialogo-novo-site +8 |
| #9ca3af sobre #ffffff · 7.5pt (10px) / peso bold · razão 2.53 (mín 4.5) | 36 | pwa-recibo-fechada-pelo-servidor, pwa-recibo-stop-nao-confirmado-cartao, pwa-recibo-stop-nao-confirmado-carteira |
| #b8bdc6 sobre #f9fafb · 6.0pt (8px) / peso bold · razão 1.8 (mín 4.5) | 28 | adm-auth-tokens, adm-carteiras, adm-charge-points, adm-connectors, adm-dashboard, adm-dialogo-novo-site +8 |
| #9ca3af sobre #ffffff · 9.0pt (12px) / peso normal · razão 2.53 (mín 4.5) | 24 | adm-dashboard, adm-financeiro |
| #939fa7 sobre #263f4e · 8.3pt (11px) / peso normal · razão 4.07 (mín 4.5) | 14 | adm-auth-tokens, adm-carteiras, adm-charge-points, adm-connectors, adm-dashboard, adm-dialogo-novo-site +8 |
| #9ca3af sobre #f9fafb · 8.3pt (11px) / peso bold · razão 2.42 (mín 4.5) | 14 | adm-auth-tokens, adm-carteiras, adm-charge-points, adm-connectors, adm-dashboard, adm-dialogo-novo-site +8 |
| #9ca3af sobre #ffffff · 9.0pt (12px) / peso bold · razão 2.53 (mín 4.5) | 6 | pub-qr-conector, pwa-recibo-fechada-pelo-servidor |
| #9ca3af sobre #f3f4f6 · 7.5pt (10px) / peso bold · razão 2.3 (mín 4.5) | 6 | pwa-travado-sessao-faulted |
| #6b7280 sobre #eff3f6 · 9.0pt (12px) / peso normal · razão 4.33 (mín 4.5) | 4 | pwa-inicio, pwa-mapa |
| #9ca3af sobre #ffffff · 10.5pt (14px) / peso normal · razão 2.53 (mín 4.5) | 3 | pwa-carteira-adicionar |
| #6b7280 sobre #f3f4f6 · 9.0pt (12px) / peso normal · razão 4.39 (mín 4.5) | 3 | pwa-recibo-fechada-pelo-servidor |
| #6b7280 sobre #e4efe6 · 9.0pt (12px) / peso normal · razão 4.09 (mín 4.5) | 2 | pwa-carteira |
| #6b7280 sobre #e4ecf0 · 9.0pt (12px) / peso normal · razão 4.04 (mín 4.5) | 2 | pwa-carteira |
| #9ca3af sobre #f9fafb · 9.0pt (12px) / peso bold · razão 2.42 (mín 4.5) | 2 | pwa-travado-sessao-faulted |

## Por classe de cor de texto (extraída do HTML do nó)

| Classe | Nós | Razão (mín–máx) | Rotas |
|---|---:|---|---|
| `text-ink-softer` | 148 | 4.04–4.47 | adm-auth-tokens, adm-carteiras, adm-charge-points, adm-connectors, adm-dialogo-novo-site +9 |
| `(sem classe de cor no trecho)` | 128 | 2.53–4.39 | adm-auth-tokens, adm-carteiras, adm-charge-points, adm-connectors, adm-dashboard +12 |
| `text-ink-subtle` | 116 | 1.8–2.53 | adm-auth-tokens, adm-carteiras, adm-charge-points, adm-connectors, adm-dashboard +14 |
| `text-ink-soft` | 39 | 4.07–4.07 | adm-auth-tokens, adm-carteiras, adm-charge-points, adm-connectors, adm-dashboard +9 |
| `text-white/50` | 14 | 4.07–4.07 | adm-auth-tokens, adm-carteiras, adm-charge-points, adm-connectors, adm-dashboard +9 |

## Por rota × viewport (reprovados / incompletos)

| Rota | 375 | 768 | 1440 |
|---|---:|---:|---:|
| adm-auditoria | 0 / 1 | 0 / 1 | 0 / 1 |
| adm-auth-tokens | 4 / 0 | 7 / 0 | 13 / 0 |
| adm-carteiras | 4 / 0 | 6 / 0 | 12 / 0 |
| adm-charge-points | 4 / 0 | 8 / 0 | 15 / 0 |
| adm-connectors | 6 / 0 | 9 / 0 | 15 / 0 |
| adm-dashboard | 7 / 1 | 8 / 3 | 14 / 3 |
| adm-dialogo-novo-site | 4 / 0 | 7 / 0 | 13 / 0 |
| adm-faturamento | 1 / 1 | 2 / 1 | 8 / 1 |
| adm-financeiro | 3 / 1 | 4 / 1 | 10 / 1 |
| adm-gateway-pagamento | 1 / 1 | 2 / 0 | 8 / 0 |
| adm-movimento-diario | 0 / 1 | 8 / 1 | 14 / 1 |
| adm-pagamentos | 0 / 1 | 8 / 0 | 14 / 0 |
| adm-sessoes | 0 / 1 | 8 / 0 | 15 / 0 |
| adm-sites | 4 / 0 | 7 / 0 | 13 / 0 |
| adm-tariffs | 5 / 0 | 9 / 0 | 15 / 0 |
| auth-cadastro | 0 / 4 | 0 / 3 | 0 / 3 |
| auth-login | 0 / 0 | 0 / 0 | 0 / 10 |
| pub-cartao-isolado-sem-opener | 0 / 0 | 0 / 0 | 0 / 0 |
| pub-eletropostos | 10 / 0 | 10 / 0 | 10 / 0 |
| pub-landing | 0 / 106 | 0 / 104 | 0 / 118 |
| pub-qr-carregador | 0 / 4 | 0 / 3 | 0 / 3 |
| pub-qr-conector | 1 / 4 | 1 / 4 | 1 / 4 |
| pub-rota-inexistente | 0 / 106 | 0 / 104 | 0 / 118 |
| pwa-carteira | 2 / 0 | 2 / 0 | 0 / 17 |
| pwa-carteira-adicionar | 1 / 0 | 1 / 0 | 1 / 15 |
| pwa-cartoes | 0 / 0 | 0 / 0 | 0 / 12 |
| pwa-historico-vazio | 0 / 0 | 0 / 0 | 0 / 10 |
| pwa-inicio | 1 / 0 | 1 / 0 | 0 / 19 |
| pwa-mapa | 13 / 5 | 13 / 0 | 12 / 26 |
| pwa-recibo-fechada-pelo-servidor | 6 / 1 | 6 / 1 | 6 / 12 |
| pwa-recibo-stop-nao-confirmado-cartao | 4 / 0 | 4 / 0 | 4 / 12 |
| pwa-recibo-stop-nao-confirmado-carteira | 4 / 0 | 4 / 0 | 4 / 11 |
| pwa-sessao-vazia | 0 / 0 | 0 / 0 | 0 / 9 |
| pwa-travado-historico | 0 / 0 | 0 / 0 | 0 / 12 |
| pwa-travado-sessao-faulted | 3 / 2 | 3 / 2 | 2 / 12 |
