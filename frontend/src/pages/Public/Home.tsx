import { Link } from "react-router-dom"
import { MapPin, ShieldCheck, Zap } from "lucide-react"
import { buttonVariants } from "@/components/ui/buttonVariants"

export function Home() {
  return (
    <div>
      <section className="border-b border-border-subtle bg-gradient-to-b from-primary-50 to-background">
        <div className="container-app py-16 text-center sm:py-24">
          <span className="inline-flex items-center gap-1.5 rounded-full bg-primary/10 px-3 py-1 text-xs font-bold uppercase tracking-wide text-primary-700">
            <Zap className="h-3.5 w-3.5" aria-hidden="true" />
            Rede de recarga
          </span>
          <h1 className="mx-auto mt-4 max-w-2xl text-3xl font-black tracking-tight text-ink sm:text-5xl">
            Encontre um eletroposto e recarregue seu carro
          </h1>
          <p className="mx-auto mt-4 max-w-xl text-base text-ink-softer sm:text-lg">
            Consulte a disponibilidade dos conectores em tempo real, por tipo e potência, em todos os operadores da
            plataforma InnoElektron.
          </p>
          <div className="mt-8 flex justify-center gap-3">
            <Link to="/eletropostos" className={buttonVariants({ size: "lg" })}>
              <MapPin className="h-4 w-4" aria-hidden="true" />
              Ver eletropostos
            </Link>
          </div>
        </div>
      </section>

      <section className="container-app grid gap-6 py-16 sm:grid-cols-3">
        <div className="flex flex-col items-start gap-2">
          <span className="flex h-11 w-11 items-center justify-center rounded-2xl bg-primary/10 text-primary">
            <MapPin className="h-5 w-5" aria-hidden="true" />
          </span>
          <p className="font-bold text-ink">Cobertura multi-operador</p>
          <p className="text-sm text-ink-softer">Eletropostos de várias empresas, numa única rede consultável.</p>
        </div>
        <div className="flex flex-col items-start gap-2">
          <span className="flex h-11 w-11 items-center justify-center rounded-2xl bg-primary/10 text-primary">
            <Zap className="h-5 w-5" aria-hidden="true" />
          </span>
          <p className="font-bold text-ink">AC e DC, na mesma busca</p>
          <p className="text-sm text-ink-softer">AC Tipo 2, DC CCS2 e DC CHAdeMO, com a potência de cada conector.</p>
        </div>
        <div className="flex flex-col items-start gap-2">
          <span className="flex h-11 w-11 items-center justify-center rounded-2xl bg-primary/10 text-primary">
            <ShieldCheck className="h-5 w-5" aria-hidden="true" />
          </span>
          <p className="font-bold text-ink">Conta única de rede</p>
          <p className="text-sm text-ink-softer">Cadastre-se uma vez e use em qualquer operador da plataforma.</p>
        </div>
      </section>
    </div>
  )
}
