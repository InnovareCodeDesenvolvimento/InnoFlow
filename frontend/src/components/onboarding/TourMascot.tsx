import m320 from "@/assets/landing/mascote-320.webp?url"
import m480 from "@/assets/landing/mascote-480.webp?url"
import { cn } from "@/lib/utils"
import "./tour.css"

/**
 * Mascote animado do onboarding (tour e checklist). A arte é a MESMA da landing (`brand/Mascot`: 1006x1358, azul-marinho muito escuro) e por isso mora sempre sobre superfície ESCURA
 * (`.surface-dark`) com o brilho `.brand-backlight` atrás. A arte é uma imagem única, sem camadas, então a animação é feita POR FORA dela, só com CSS (zero JavaScript por quadro, zero lib):
 *   - respiração  (`tm-breathe`) — escala suave a partir dos pés, em loop;
 *   - olhar       (`data-look`) — o corpo se inclina para o lado do elemento que o balão está apontando (o rosto da arte é fixo: não dá para mover só as pupilas);
 *   - LED         (`tm-led`) — pulsa o brilho lima do raio do fone e do raio do conector (posições medidas na arte);
 *   - piscar      (`tm-eye`) — duas pálpebras escuras com um traço lima por cima dos olhos, mesma técnica da landing;
 *   - aceno       (`data-wave`) — uma balançada + pulinho ao entrar em cada passo (um tiro só, remontado pela `key`); no passo final (`mood="happy"`) o pulinho é maior.
 * Com `prefers-reduced-motion: reduce` NADA se move (as animações só existem sob `no-preference`): fica a figura estática, com o brilho dos LEDs fixo.
 * A figura é decorativa (`aria-hidden`): o texto do balão carrega o sentido.
 */

const SRCSET = `${m320} 320w, ${m480} 480w`

export type MascotLook = "none" | "left" | "right" | "up" | "down"

interface TourMascotProps {
  /** `sm` ~104 px de altura (balão de passo), `lg` ~176 px (boas-vindas e fim). */
  size?: "sm" | "lg"
  mood?: "idle" | "happy"
  look?: MascotLook
  /** Muda a cada passo: reinicia o aceno de um tiro só. */
  waveKey?: string
  className?: string
}

export function TourMascot({ size = "sm", mood = "idle", look = "none", waveKey, className }: TourMascotProps) {
  return (
    <div className={cn("tm", className)} data-size={size} data-mood={mood} aria-hidden="true">
      <div className="brand-backlight" />
      <div className="tm-look" data-look={look}>
        <div className="tm-wave" key={waveKey} data-wave="">
          <div className="tm-body">
            <img src={m320} srcSet={SRCSET} sizes={size === "lg" ? "132px" : "78px"} width={1006} height={1358} alt="" decoding="async" draggable={false} />
            <span className="tm-eye" data-eye="l" />
            <span className="tm-eye" data-eye="r" />
            <span className="tm-led" data-led="ear" />
            <span className="tm-led" data-led="plug" />
          </div>
        </div>
      </div>
    </div>
  )
}
