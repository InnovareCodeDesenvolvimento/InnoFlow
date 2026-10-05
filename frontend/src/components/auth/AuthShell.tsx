import type { ReactNode } from "react"
import { Link } from "react-router-dom"
import { Check } from "lucide-react"
import { BrandBackdrop } from "@/components/brand/BrandBackdrop"
import { Logo } from "@/components/brand/Logo"
import { Mascot, MascotFace } from "@/components/brand/Mascot"
import { LEGAL_PATHS } from "@/lib/legalPaths"

/**
 * Casca de Login e Cadastro (design system unificado, F-B): MOLDURA ESCURA de marca + miolo claro, igual à regra da landing (escuro emoldura, claro é
 * onde se lê). Decisão D4 do dono: a tela fala com o MOTORISTA — o texto do painel de marca não menciona painel administrativo nem operadores
 * (quem opera entra pelo mesmo formulário, mas o painel de marca é do produto que o motorista conhece).
 *
 *  - Desktop (>= lg): painel de marca à esquerda (`surface-dark-rich` + mascote de corpo inteiro + 3 benefícios com check lima), formulário à direita.
 *    O mascote some em janelas baixas (< 760 px de altura), para o painel nunca estourar a tela.
 *  - Mobile: faixa escura curta no topo (logo, rosto do mascote e slogan) e o card do formulário "flutuando" sobre a fronteira (`-mt-10`).
 *  - Sem os blobs `blur-3xl` animados de antes (custo de rasterização; a landing os abandonou): o fundo é o `BrandBackdrop` estático.
 *  - O cartão do formulário é CLARO (miolo de leitura). O CTA único é lima; quem monta a tela decide (`Button variant="lime"`).
 * O texto dos benefícios repete os três da landing (`HERO_POINTS`) de propósito, sem importar `landing-data` (não cruzar chunk com a landing).
 */
const POINTS = [
  "Veja o que está livre agora, com tipo e potência de cada conector",
  "Confira a tarifa antes de iniciar a recarga",
  "Acompanhe e pare a recarga pelo celular",
] as const

export function AuthShell({ children, below }: { children: ReactNode; /** Linha abaixo do card (ex.: "Ainda não tem conta? Cadastre-se"). */ below?: ReactNode }) {
  return (
    <div className="grid min-h-screen lg:grid-cols-2">
      {/* Painel de marca — só desktop (>= lg). */}
      <aside className="surface-dark surface-dark-rich relative hidden overflow-hidden lg:flex lg:flex-col lg:justify-between lg:p-12 xl:p-16">
        <BrandBackdrop dots />

        <Link to="/" className="relative z-10 inline-flex w-fit items-center">
          <Logo tone="dark" size={40} />
        </Link>

        <div className="relative z-10 max-w-md">
          <p className="text-4xl font-extrabold leading-[1.1] tracking-tight text-white xl:text-5xl">
            Carregue um <span className="bg-gradient-to-r from-lime to-primary-300 bg-clip-text text-transparent">futuro melhor</span>.
          </p>
          <p className="mt-4 text-base leading-relaxed text-ink-soft">
            Encontre um eletroposto, escaneie o QR code no carregador e acompanhe a recarga pelo celular. Seu saldo, seus cartões e seu histórico ficam na sua conta.
          </p>
          <ul className="mt-8 space-y-3">
            {POINTS.map((text) => (
              <li key={text} className="flex items-start gap-3 text-sm font-medium text-white/90">
                <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-lime text-on-lime" aria-hidden="true">
                  <Check className="h-3 w-3" strokeWidth={3.5} />
                </span>
                {text}
              </li>
            ))}
          </ul>
        </div>

        <div className="relative z-10 flex items-end justify-between gap-6">
          <p className="text-xs text-ink-softer">© {new Date().getFullYear()} InnoFlow. Carregue um futuro melhor.</p>
          <div className="relative [@media(max-height:760px)]:hidden" aria-hidden="true">
            <div className="brand-backlight" />
            <Mascot sizes="(min-width: 1280px) 260px, 220px" className="[--m-h:240px] xl:[--m-h:300px]" />
          </div>
        </div>
      </aside>

      {/* `main`: o miolo do acesso é a região principal da página (sem landmark, o axe reprova `landmark-one-main` em Login, Cadastro e na recuperação de senha). Mesmo box de antes: só a tag mudou. */}
      <main className="relative flex flex-col bg-background">
        {/* Faixa de marca — só mobile/tablet (< lg). */}
        <div className="surface-dark surface-dark-rich relative shrink-0 overflow-hidden px-4 pb-16 pt-8 text-center lg:hidden">
          <BrandBackdrop />
          <div className="relative z-10 mx-auto flex max-w-sm flex-col items-center gap-3">
            <Link to="/" className="flex items-center gap-2.5">
              <MascotFace size={44} className="rounded-full bg-white/10 ring-1 ring-white/15" />
              <span className="text-lg font-extrabold tracking-tight text-white">InnoFlow</span>
            </Link>
            <p className="text-xl font-extrabold leading-snug tracking-tight text-white sm:text-2xl">
              Carregue um <span className="bg-gradient-to-r from-lime to-primary-300 bg-clip-text text-transparent">futuro melhor</span>.
            </p>
          </div>
        </div>

        <div className="relative z-10 mx-auto -mt-10 w-full max-w-sm flex-1 px-4 pb-12 lg:mt-0 lg:flex lg:max-w-md lg:flex-col lg:justify-center lg:px-0 lg:pb-12 lg:pt-12">
          {children}
          {below}
        </div>
        {/* Links legais (L1.9): posicionados DENTRO do respiro de 48 px do fim da coluna (`pb-12`), então não empurram nem recentralizam o formulário (o card fica onde sempre esteve). Alvo de 44 px. */}
        <nav aria-label="Documentos legais" className="absolute inset-x-0 bottom-0 z-10 flex h-11 items-center justify-center gap-x-5 text-xs text-ink-softer">
          <Link to={LEGAL_PATHS.termos} className="inline-flex min-h-11 items-center px-1 font-medium underline-offset-2 hover:text-ink hover:underline">
            Termos de Uso
          </Link>
          <Link to={LEGAL_PATHS.privacidade} className="inline-flex min-h-11 items-center px-1 font-medium underline-offset-2 hover:text-ink hover:underline">
            Política de Privacidade
          </Link>
        </nav>
      </main>
    </div>
  )
}
