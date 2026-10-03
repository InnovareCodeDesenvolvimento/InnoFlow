import { Reveal } from "./Reveal"

/** Cabeçalho padrão de seção: etiqueta, h2 e parágrafo. `tone="dark"` para fundos escuros. */
export function SectionHeading({
  eyebrow,
  title,
  description,
  tone = "light",
  align = "center",
  id,
}: {
  eyebrow?: string
  title: string
  description?: string
  tone?: "light" | "dark"
  align?: "center" | "left"
  id: string
}) {
  const dark = tone === "dark"
  return (
    <Reveal className={`max-w-2xl ${align === "center" ? "mx-auto text-center" : ""}`}>
      {eyebrow ? <p className={`lnd-eyebrow ${dark ? "text-accent-glow" : "text-accent-700"}`}>{eyebrow}</p> : null}
      <h2
        id={id}
        className={`${eyebrow ? "mt-3" : ""} text-balance text-3xl font-extrabold leading-tight tracking-tight sm:text-4xl ${dark ? "!text-white" : "text-ink"}`}
      >
        {title}
      </h2>
      {description ? (
        <p className={`mt-4 text-base leading-relaxed sm:text-lg ${dark ? "text-white/80" : "text-ink-soft"}`}>{description}</p>
      ) : null}
    </Reveal>
  )
}
