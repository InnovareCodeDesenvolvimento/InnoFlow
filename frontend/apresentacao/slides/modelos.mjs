/** Modelos de slide: cada função devolve o HTML de UM slide (1920x1080). O conteúdo (texto) vem dos arquivos conteudo-*.mjs. */

export const esc = (s) =>
  String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")

const CAPTURAS = "../../capturas"
const ICONE = "../../marca/icone-innoflow.png"
const MASCOTE = "../../../src/assets/landing/mascote-900.webp"

export const NOTA_DEMO = "Documento de apresentação — ambiente de demonstração com dados fictícios"

const ICONE_INFO = `<svg viewBox="0 0 24 24" fill="none" stroke="#29698E" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9.5"/><path d="M12 11v5.5M12 7.6v.1"/></svg>`
const SETA = `<div class="seta" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="#29698E" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14M13 6l6 6-6 6"/></svg></div>`

function marca() {
  return `<span class="marca"><img src="${ICONE}" alt="" />InnoFlow</span>`
}
function topo(ctx, secao) {
  return `<header class="topo">${marca()}<div class="trilha">${esc(ctx.produto)}${secao ? ` &nbsp;·&nbsp; <b>${esc(secao)}</b>` : ""}</div></header>`
}
function rodape(ctx, n, total) {
  return `<footer class="rodape"><span>${esc(NOTA_DEMO)}</span><span class="pg">${n} / ${total}</span></footer>`
}
function claro(ctx, n, total, secao, conteudo, extra = "") {
  return `<section class="slide" ${extra}>${topo(ctx, secao)}<div class="corpo">${conteudo}</div>${rodape(ctx, n, total)}</section>`
}

// ---------------------------------------------------------------- dispositivos
export function janela(id, titulo, { w = 1104, ar = [1440, 900] } = {}) {
  const alt = `Captura da tela: ${titulo}`
  void ar
  return `<div class="nav-frame" style="--w:${w}px"><div class="nav-bar"><i></i><i></i><i></i><span>${esc(titulo)}</span></div><img src="${CAPTURAS}/${id}.jpg" alt="${esc(alt)}" /></div>`
}
export function fone(id, alt, { w = 372, corte = false } = {}) {
  return `<div class="fone${corte ? " corte" : ""}" style="--fw:${w}px"><img src="${CAPTURAS}/${id}.jpg" alt="${esc(alt)}" /></div>`
}
function par(item, w, opcoes = {}) {
  const passo = item.passo ? `<span class="passo">${item.passo}</span>` : ""
  const leg = item.legenda ? `<div class="legenda">${passo}${esc(item.legenda)}${item.sub ? `<small>${esc(item.sub)}</small>` : ""}</div>` : ""
  return `<div class="par">${fone(item.img, item.alt ?? item.legenda ?? "Captura do app", { w, ...opcoes })}${leg}</div>`
}

// ---------------------------------------------------------------- slides
export function capa(ctx, s) {
  return `<section class="slide escuro capa">
  <div class="brilho"></div>
  <span class="marca"><img src="${ICONE}" alt="" />InnoFlow</span>
  <div class="texto">
    <div class="eyebrow">${esc(s.eyebrow)}</div>
    <h1>${s.titulo}</h1>
    <p class="sub">${esc(s.subtitulo)}</p>
    <div class="chips"><span class="chip lima">${esc(s.data)}</span><span class="chip">${esc(NOTA_DEMO)}</span></div>
  </div>
  <img class="mascote" src="${MASCOTE}" alt="Mascote do InnoFlow segurando o plugue de recarga" />
</section>`
}

export function visao(ctx, s, n, total) {
  const cards = s.areas
    .map(
      (a, i) => `<article class="cartao"><div class="num">${i + 1}</div><h2>${esc(a.titulo)}</h2><p>${esc(a.texto)}</p><ul>${a.telas.map((t) => `<li>${esc(t)}</li>`).join("")}</ul></article>`,
    )
    .join("")
  return claro(
    ctx,
    n,
    total,
    "Visão geral",
    `<div class="eyebrow">${esc(s.eyebrow)}</div><h1 class="titulo">${esc(s.titulo)}</h1><p class="lead" style="max-width:1300px">${esc(s.lead)}</p>
     <div class="cartoes">${cards}</div>
     <div class="aviso">${ICONE_INFO}<span>${esc(s.aviso)}</span></div>`,
  )
}

export function abertura(ctx, s) {
  const itens = s.telas.map((t, i) => `<div class="item-tela"><div class="n">${i + 1}</div><div><b>${esc(t.rotulo)}</b><span>${esc(t.resumo)}</span></div></div>`).join("")
  return `<section class="slide escuro abertura">
  <header class="topo" style="background:none">${marca()}<div class="trilha">${esc(ctx.produto)}</div></header>
  <div class="indice">${String(s.indice).padStart(2, "0")}</div>
  <div class="texto"><div class="eyebrow">Seção ${s.indice}</div><h1>${esc(s.titulo)}</h1><p class="sub">${esc(s.subtitulo)}</p></div>
  <div class="telas"><div class="rotulo-lista">Nesta seção</div>${itens}</div>
  <div class="trilha-fina"><span>${esc(NOTA_DEMO)}</span><span>${s.pg} / ${s.total}</span></div>
</section>`
}

function pontos(lista) {
  return `<ul class="pontos">${lista.map((p) => `<li><span>${esc(p)}</span></li>`).join("")}</ul>`
}

export function tela(ctx, s, n, total) {
  let midia
  if (s.midia.tipo === "janela") {
    if (s.midia.pendente) {
      midia = `<div class="palco solto"><div class="pendente" data-pendente-recaptura="true"><b>Captura pendente</b><span>${esc(s.midia.pendente)}</span></div></div>`
    } else {
      midia = `<div class="palco solto">${janela(s.midia.img, s.midia.titulo)}</div>`
    }
  } else if (s.midia.tipo === "janela+fone") {
    midia = `<div class="palco solto" style="gap:28px;position:relative">${janela(s.midia.img, s.midia.titulo, { w: 800 })}${fone(s.midia.fone, s.midia.foneAlt ?? "Captura do app no celular", { w: 250 })}</div>`
  } else {
    const w = s.midia.w ?? 372
    const itens = s.midia.itens
    const partes = []
    itens.forEach((it, i) => {
      if (i > 0 && s.midia.seta) partes.push(SETA)
      partes.push(par(it, w))
    })
    midia = `<div class="palco">${partes.join("")}</div>`
  }
  const texto = `<div class="texto"><div class="eyebrow">${esc(s.eyebrow)}</div><h1 class="titulo">${esc(s.titulo)}</h1><p class="lead">${esc(s.lead)}</p>${pontos(s.pontos)}${s.nota ? `<p class="nota">${esc(s.nota)}</p>` : ""}</div>`
  return claro(ctx, n, total, s.secaoNome, `<div class="tela${s.inverso ? " inverso" : ""}">${texto}${midia}</div>`, s.midia.pendente ? 'data-pendente-recaptura="true"' : "")
}

export function jornada(ctx, s, n, total) {
  const itens = []
  s.passos.forEach((p, i) => {
    if (i > 0) itens.push(SETA)
    itens.push(par({ ...p, passo: i + 1 }, 300, { corte: true }))
  })
  return claro(
    ctx,
    n,
    total,
    s.secaoNome,
    `<div class="eyebrow">${esc(s.eyebrow)}</div><h1 class="titulo">${esc(s.titulo)}</h1><p class="lead" style="max-width:1400px;margin-top:14px;font-size:24px">${esc(s.lead)}</p>
     <div class="faixa centro">${itens.join("")}</div>`,
  )
}

export function falhas(ctx, s, n, total) {
  const itens = s.itens.map((p) => par(p, 284)).join("")
  return claro(
    ctx,
    n,
    total,
    s.secaoNome,
    `<div class="eyebrow">${esc(s.eyebrow)}</div><h1 class="titulo">${esc(s.titulo)}</h1><p class="lead" style="max-width:1500px;margin-top:14px;font-size:24px">${esc(s.lead)}</p>
     <div class="faixa" style="justify-content:space-between">${itens}</div>`,
  )
}

export function perfis(ctx, s, n, total) {
  return claro(
    ctx,
    n,
    total,
    s.secaoNome,
    `<div class="eyebrow">${esc(s.eyebrow)}</div><h1 class="titulo" style="font-size:48px">${esc(s.titulo)}</h1><p class="lead" style="margin-top:12px;font-size:24px">${esc(s.lead)}</p>
     <div class="duas-janelas">
       <div class="col"><h3><span>OPERATOR</span>${esc(s.esq.titulo)}</h3>${janela(s.esq.img, s.esq.janela, { w: 800 })}<p>${esc(s.esq.texto)}</p></div>
       <div class="col"><h3><span>OPERATOR</span>${esc(s.dir.titulo)}</h3>${janela(s.dir.img, s.dir.janela, { w: 800 })}<p>${esc(s.dir.texto)}</p></div>
     </div>`,
  )
}

export function quadroPerfis(ctx, s, n, total) {
  const col = (c) => `<div class="bloco"><h2>${esc(c.titulo)}</h2>${pontos(c.pontos)}</div>`
  return claro(
    ctx,
    n,
    total,
    s.secaoNome,
    `<div class="eyebrow">${esc(s.eyebrow)}</div><h1 class="titulo">${esc(s.titulo)}</h1><p class="lead" style="max-width:1400px">${esc(s.lead)}</p>
     <div class="quadro-perfis" style="margin-top:34px">${col(s.admin)}${col(s.operador)}</div>
     <div class="aviso">${ICONE_INFO}<span>${esc(s.aviso)}</span></div>`,
  )
}

export function entregue(ctx, s, n, total) {
  const cols = s.blocos.map((b) => `<div class="bloco"><h2>${esc(b.titulo)}</h2>${pontos(b.pontos)}</div>`).join("")
  return claro(
    ctx,
    n,
    total,
    "Encerramento",
    `<div class="eyebrow">${esc(s.eyebrow)}</div><h1 class="titulo">${esc(s.titulo)}</h1><p class="lead" style="max-width:1500px">${esc(s.lead)}</p>
     <div class="colunas">${cols}</div>
     <div class="numeros">${(s.numeros ?? []).map((n) => `<div class="numero"><b>${esc(n.valor)}</b><span>${esc(n.rotulo)}</span></div>`).join("")}</div>
     <div class="aviso">${ICONE_INFO}<span>${esc(s.aviso)}</span></div>`,
  )
}

export function etapas(ctx, s, n, total) {
  const lista = s.etapas
    .map((e, i) => {
      const tag = e.destaque ? `<span class="tag">Afeta o motorista</span>` : ""
      return `<article class="etapa"><div class="n">${i + 1}</div><div><h2>${esc(e.titulo)}${tag}</h2><p>${esc(e.texto)}</p></div></article>`
    })
    .join("")
  return claro(
    ctx,
    n,
    total,
    "Próximas etapas",
    `<div class="eyebrow">${esc(s.eyebrow)}</div>
     <h1 class="titulo" style="display:flex;align-items:center;gap:22px;flex-wrap:wrap">${esc(s.titulo)}<span class="tag neutra" style="font-size:19px;padding:6px 16px">Datas a combinar</span></h1>
     <div class="etapas">
       <div class="linha-tempo">${lista}</div>
       <aside class="dependencias"><h2>Dependências do contratante</h2><ul>${s.dependencias.map((d) => `<li>${esc(d)}</li>`).join("")}</ul><p class="rodape-nota">${esc(s.notaDependencias)}</p></aside>
     </div>`,
  )
}

export const MODELOS = { capa, visao, abertura, tela, jornada, falhas, perfis, quadroPerfis, entregue, etapas }
