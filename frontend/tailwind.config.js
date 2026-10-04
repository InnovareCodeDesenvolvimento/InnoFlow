import tailwindcssAnimate from "tailwindcss-animate"

/** @type {import('tailwindcss').Config} */
export default {
  darkMode: ["class"],
  // `src/dev/` = catálogo `/__ds` (só em dev, fora do build — ver App.tsx): no build de produção suas classes não entram no CSS global.
  content: ["./index.html", "./src/**/*.{ts,tsx,js,jsx}", ...(process.env.NODE_ENV === "production" ? ["!./src/dev/**"] : [])],
  theme: {
    extend: {
      // Paleta via CSS variable — ver comentário em src/index.css (:root)
      // para o valor hex por trás de cada token.
      colors: {
        primary: {
          DEFAULT: "rgb(var(--color-primary) / <alpha-value>)",
          50: "rgb(var(--color-primary-50) / <alpha-value>)",
          100: "rgb(var(--color-primary-100) / <alpha-value>)",
          200: "rgb(var(--color-primary-200) / <alpha-value>)",
          300: "rgb(var(--color-primary-300) / <alpha-value>)",
          400: "rgb(var(--color-primary-400) / <alpha-value>)",
          500: "rgb(var(--color-primary-500) / <alpha-value>)",
          600: "rgb(var(--color-primary-600) / <alpha-value>)",
          700: "rgb(var(--color-primary-700) / <alpha-value>)",
          800: "rgb(var(--color-primary-800) / <alpha-value>)",
          900: "rgb(var(--color-primary-900) / <alpha-value>)",
          950: "rgb(var(--color-primary-950) / <alpha-value>)",
          foreground: "rgb(var(--color-primary-foreground) / <alpha-value>)",
        },
        accent: {
          DEFAULT: "rgb(var(--color-accent) / <alpha-value>)",
          50: "rgb(var(--color-accent-50) / <alpha-value>)",
          100: "rgb(var(--color-accent-100) / <alpha-value>)",
          200: "rgb(var(--color-accent-200) / <alpha-value>)",
          300: "rgb(var(--color-accent-300) / <alpha-value>)",
          400: "rgb(var(--color-accent-400) / <alpha-value>)",
          500: "rgb(var(--color-accent-500) / <alpha-value>)",
          600: "rgb(var(--color-accent-600) / <alpha-value>)",
          700: "rgb(var(--color-accent-700) / <alpha-value>)",
          foreground: "rgb(var(--color-accent-foreground) / <alpha-value>)",
        },
        success: {
          DEFAULT: "rgb(var(--color-success) / <alpha-value>)",
          50: "rgb(var(--color-success-50) / <alpha-value>)",
          100: "rgb(var(--color-success-100) / <alpha-value>)",
          600: "rgb(var(--color-success-600) / <alpha-value>)",
          700: "rgb(var(--color-success-700) / <alpha-value>)",
        },
        warning: {
          DEFAULT: "rgb(var(--color-warning) / <alpha-value>)",
          50: "rgb(var(--color-warning-50) / <alpha-value>)",
          100: "rgb(var(--color-warning-100) / <alpha-value>)",
          600: "rgb(var(--color-warning-600) / <alpha-value>)",
          700: "rgb(var(--color-warning-700) / <alpha-value>)",
        },
        danger: {
          DEFAULT: "rgb(var(--color-danger) / <alpha-value>)",
          50: "rgb(var(--color-danger-50) / <alpha-value>)",
          100: "rgb(var(--color-danger-100) / <alpha-value>)",
          600: "rgb(var(--color-danger-600) / <alpha-value>)",
          700: "rgb(var(--color-danger-700) / <alpha-value>)",
        },
        info: {
          DEFAULT: "rgb(var(--color-info) / <alpha-value>)",
          50: "rgb(var(--color-info-50) / <alpha-value>)",
          100: "rgb(var(--color-info-100) / <alpha-value>)",
          600: "rgb(var(--color-info-600) / <alpha-value>)",
          700: "rgb(var(--color-info-700) / <alpha-value>)",
        },
        // Tokens de marca decorativos (gradiente do ícone da logo) — não são
        // escalas completas de estado, só um valor cada. Ver comentário em
        // src/index.css (:root) sobre uso moderado/não-textual.
        "brand-teal": "rgb(var(--color-brand-teal) / <alpha-value>)",
        "accent-glow": "rgb(var(--color-accent-glow) / <alpha-value>)",
        // Design system unificado (F-A): ver src/index.css (tokens semânticos). `lime` = AÇÃO; `on-lime` = texto sobre ela; `focus` = anel de foco.
        night: "rgb(var(--color-night) / <alpha-value>)",
        lime: "rgb(var(--color-lime) / <alpha-value>)",
        "on-lime": "rgb(var(--color-on-lime) / <alpha-value>)",
        focus: "rgb(var(--color-focus) / <alpha-value>)",
        background: "rgb(var(--color-background) / <alpha-value>)",
        "background-warm": "rgb(var(--color-background-warm) / <alpha-value>)",
        surface: "rgb(var(--color-surface) / <alpha-value>)",
        border: {
          DEFAULT: "rgb(var(--color-border) / <alpha-value>)",
          subtle: "rgb(var(--color-border-subtle) / <alpha-value>)",
          strong: "rgb(var(--color-border-strong) / <alpha-value>)",
        },
        muted: {
          DEFAULT: "rgb(var(--color-muted) / <alpha-value>)",
          foreground: "rgb(var(--color-muted-foreground) / <alpha-value>)",
        },
        ink: {
          DEFAULT: "rgb(var(--color-ink) / <alpha-value>)",
          soft: "rgb(var(--color-ink-soft) / <alpha-value>)",
          softer: "rgb(var(--color-ink-softer) / <alpha-value>)",
          subtle: "rgb(var(--color-ink-subtle) / <alpha-value>)",
        },
      },
      fontFamily: {
        sans: ["Inter", "Inter Fallback", "system-ui", "sans-serif"],
        display: ["Inter", "Inter Fallback", "system-ui", "sans-serif"],
      },
      borderRadius: {
        none: "0",
        sm: "0.375rem",
        DEFAULT: "0.5rem",
        md: "0.625rem",
        lg: "0.75rem",
        xl: "1rem",
        "2xl": "1.25rem",
        full: "9999px",
        control: "var(--radius-control)",
        card: "var(--radius-card)",
        feature: "var(--radius-feature)",
      },
      transitionTimingFunction: {
        brand: "var(--ease-brand)",
      },
      boxShadow: {
        xs: "0 1px 2px rgba(15, 20, 25, 0.04)",
        sm: "0 1px 3px rgba(15, 20, 25, 0.06), 0 1px 2px rgba(15, 20, 25, 0.04)",
        card: "0 1px 3px rgba(15, 23, 42, 0.06), 0 1px 2px rgba(15, 23, 42, 0.04)",
        "card-hover": "0 12px 24px -8px rgba(29, 78, 216, 0.16), 0 4px 8px -4px rgba(29, 78, 216, 0.08)",
        lg: "0 16px 32px -8px rgba(15, 20, 25, 0.12), 0 4px 12px -4px rgba(15, 20, 25, 0.06)",
        // Design system unificado: sombras TINGIDAS da marca (não cinza neutro) e o brilho do CTA lima.
        tinted: "0 1px 2px rgb(15 23 42 / 0.04), 0 10px 20px -12px rgb(var(--color-primary) / 0.35)",
        "tinted-card": "0 1px 2px rgb(15 23 42 / 0.04), 0 12px 28px -16px rgb(var(--color-primary) / 0.35)",
        lime: "0 14px 30px -10px rgb(var(--color-lime) / 0.55), 0 0 0 1px rgb(255 255 255 / 0.25) inset",
        "lime-lg": "0 20px 40px -12px rgb(var(--color-lime) / 0.7), 0 0 0 1px rgb(255 255 255 / 0.35) inset",
      },
      animation: {
        "fade-in": "fadeIn 0.2s ease-out",
        "scale-in": "scaleIn 0.15s ease-out",
      },
      keyframes: {
        fadeIn: { "0%": { opacity: "0" }, "100%": { opacity: "1" } },
        scaleIn: { "0%": { opacity: "0", transform: "scale(0.97)" }, "100%": { opacity: "1", transform: "scale(1)" } },
      },
    },
  },
  plugins: [tailwindcssAnimate],
}
