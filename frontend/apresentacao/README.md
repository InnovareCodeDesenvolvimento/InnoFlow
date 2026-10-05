# Apresentação do InnoFlow (PDFs)

Gera dois PDFs 16:9 (1920x1080) para reuniões: `saida/InnoFlow-Admin.pdf` e `saida/InnoFlow-Motorista.pdf`. As telas são **capturas reais** do app em modo demonstração (MSW, dados fictícios); nada é desenhado à mão.

```bash
cd frontend
node apresentacao/gerar.mjs                      # capturas + os dois PDFs (~4 min; o mapa usa tiles do OpenStreetMap, precisa de internet)
node apresentacao/gerar.mjs --so-pdf             # só remonta os PDFs com as capturas existentes (segundos)
node apresentacao/gerar.mjs --so-capturas --quais=adm-gateway-pagamento   # refaz capturas específicas
node apresentacao/gerar.mjs --so=admin           # um PDF só
node apresentacao/gerar.mjs --gateway-pronto     # usa a captura da tela Gateway de pagamento (sem a flag o slide fica "pendente")
node apresentacao/verificar.mjs                  # mede os slides no navegador (margens, estouro, imagens)
```

- Sobe o Vite em modo mock na porta **5291** (`APRESENTACAO_PORTA` troca) e nunca reaproveita servidor existente.
- Texto dos slides: `conteudo-admin.mjs`, `conteudo-motorista.mjs`, `conteudo-comum.mjs` (próximas etapas). Visual: `slides/estilo.css` e `slides/modelos.mjs` (tokens do `DESIGN-SYSTEM.md`).
- `capturas/` e `saida/html/` não são versionados; `saida/*.pdf` são. O HTML gerado (`saida/html/*.html`) abre no navegador e imprime em PDF (1920x1080, sem margens, com gráficos de fundo).
- Nenhum mock é alterado. Únicas intervenções nas capturas: remoção do DOM dos dois controles do login que só existem no mock ("Continuar com o Google (mock)" e "Simular conta de operação (mock)") e ocultação da linha de rota técnica (`POST /api/...`) na coluna "Onde" da Auditoria.
- Relógio fixo em 05/10/2026 14:30 (exceto no mapa, onde o Leaflet precisa do relógio real para o fade dos tiles).
