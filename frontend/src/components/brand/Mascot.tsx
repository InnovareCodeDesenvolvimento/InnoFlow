import m320 from "@/assets/landing/mascote-320.webp"
import m480 from "@/assets/landing/mascote-480.webp"
import m640 from "@/assets/landing/mascote-640.webp"
import m900 from "@/assets/landing/mascote-900.webp"
import face64 from "@/assets/landing/mascote-rosto-64.webp"
import face128 from "@/assets/landing/mascote-rosto-128.webp"

/**
 * Mascote da InnoFlow (arte `Mascote_InnoFlow.png`, tratada por `frontend/scripts/gerar-mascote.py`: halo
 * semitransparente removido, recorte limpo, webp em 4 tamanhos). A arte é azul-marinho muito escuro: sempre sobre
 * fundo ESCURO com brilho atrás (`.lnd-backlight`), nunca solta no branco sem sombra.
 *
 * Dimensões reais do recorte: 1006x1358 (proporção 0,741) — `width`/`height` no <img> reservam o espaço (sem CLS).
 *
 * Mora em `components/brand` (design system unificado, F-A) e a landing REEXPORTA de `components/landing/Mascot.tsx`. A caixa leva as duas
 * classes: `lnd-mascot-box` (landing.css, o que a landing sempre usou) e `brand-mascot-box` (index.css, `@layer components`, para as telas
 * fora da landing, onde landing.css nem é carregado). A altura vem de `--m-h` (a landing o define em `.lnd-stage`; fora dela, passe
 * `style={{ "--m-h": "280px" }}` ou a classe `[--m-h:280px]`; padrão 280 px). Mascote só sobre superfície ESCURA (`.surface-dark`).
 * Regra de ouro: a landing NÃO importa `components/ui` nem shells — este arquivo só importa assets.
 */
export const MASCOT_ALT =
  "Mascote da InnoFlow: robô azul-marinho com detalhes em verde-limão e uma folha no capacete, fazendo joinha com uma mão e segurando um carregador de veículo elétrico na outra."

const SRCSET = `${m320} 320w, ${m480} 480w, ${m640} 640w, ${m900} 900w`

/**
 * Posição das pálpebras (em % do recorte 1006x1358) — medidas sobre o olho esquerdo e o direito da arte. Piscar =
 * duas elipses escuras com um traço lima, ligadas por CSS só sem `prefers-reduced-motion: reduce`.
 */
const EYES = [
  { id: "l", left: "39.2%", top: "28.9%", width: "14.6%", height: "10.6%" },
  { id: "r", left: "61.4%", top: "31.9%", width: "12.4%", height: "10%" },
] as const

interface MascotProps {
  /** Sobe a prioridade de carregamento (hero). O resto da página usa lazy. */
  priority?: boolean
  /** `sizes` do <img>, conforme a altura em que o mascote é exibido. */
  sizes: string
  /** Liga o piscar (só o do hero). */
  blink?: boolean
  className?: string
}

export function Mascot({ priority = false, sizes, blink = false, className }: MascotProps) {
  return (
    <div className={`lnd-mascot-box brand-mascot-box ${className ?? ""}`}>
      <img
        src={m640}
        srcSet={SRCSET}
        sizes={sizes}
        width={1006}
        height={1358}
        alt={MASCOT_ALT}
        decoding="async"
        loading={priority ? "eager" : "lazy"}
        fetchPriority={priority ? "high" : "auto"}
        draggable={false}
      />
      {blink &&
        EYES.map((eye) => (
          <span key={eye.id} className="lnd-eye" data-eye={eye.id} style={{ left: eye.left, top: eye.top, width: eye.width, height: eye.height }} aria-hidden="true" />
        ))}
    </div>
  )
}

/** Rosto recortado (quadrado) para selos pequenos. 64px com 2x = 128px. */
export function MascotFace({ size, className }: { size: number; className?: string }) {
  return (
    <img
      src={face64}
      srcSet={`${face64} 64w, ${face128} 128w`}
      sizes={`${size}px`}
      width={size}
      height={size}
      alt=""
      aria-hidden="true"
      decoding="async"
      loading="lazy"
      className={className}
    />
  )
}
