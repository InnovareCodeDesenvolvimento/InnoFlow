import { createContext, useContext } from "react"
import { cn } from "@/lib/utils"

/**
 * Primitivos de tabela para as listagens admin. Sem paginação/estado embutido
 * de propósito — isso é do `Pagination` e do hook de query de cada tela;
 * este componente só cuida da apresentação.
 *
 * `density`: `comfortable` (padrão, py-3 — o de hoje) para listas de cadastro (Sites, Tarifas) e `compact` (py-2, ~44 px por linha)
 * para listas longas (Sessões, Pagamentos, Auditoria, Carteiras). A célula lê a densidade por contexto: nada muda nas telas que não passam a prop.
 * Texto de tabela é `ink-soft` 14 px; cabeçalho 11 px 700 `ink-softer` (>= 4,5:1 desde a correção de contraste da F-A).
 */
type Density = "comfortable" | "compact"
const DensityContext = createContext<Density>("comfortable")

function Table({ className, density = "comfortable", ...props }: React.TableHTMLAttributes<HTMLTableElement> & { density?: Density }) {
  return (
    <DensityContext.Provider value={density}>
      {/* `relative`: contém elementos `absolute` (ex.: `sr-only` num <th>) DENTRO do scroller — sem isso
          eles escapam do `overflow-x-auto` e criam scroll horizontal na página inteira (achado em Carteiras, 390px). */}
      <div className="table-premium relative w-full overflow-x-auto rounded-xl border border-border-subtle" data-density={density}>
        <table className={cn("w-full min-w-[640px] border-collapse text-sm", className)} {...props} />
      </div>
    </DensityContext.Provider>
  )
}

function TableHeader({ className, ...props }: React.HTMLAttributes<HTMLTableSectionElement>) {
  return <thead className={cn("bg-muted/60", className)} {...props} />
}

function TableBody({ className, ...props }: React.HTMLAttributes<HTMLTableSectionElement>) {
  return <tbody className={cn("divide-y divide-border-subtle", className)} {...props} />
}

function TableRow({ className, ...props }: React.HTMLAttributes<HTMLTableRowElement>) {
  return <tr className={cn("transition-colors hover:bg-muted/40", className)} {...props} />
}

function TableHead({ className, ...props }: React.ThHTMLAttributes<HTMLTableCellElement>) {
  const density = useContext(DensityContext)
  return (
    <th
      className={cn(
        "whitespace-nowrap px-4 text-left text-[11px] font-bold uppercase tracking-wide text-ink-softer",
        density === "compact" ? "py-2" : "py-3",
        className,
      )}
      {...props}
    />
  )
}

function TableCell({ className, ...props }: React.TdHTMLAttributes<HTMLTableCellElement>) {
  const density = useContext(DensityContext)
  return <td className={cn("px-4 align-middle text-ink-soft", density === "compact" ? "py-2" : "py-3", className)} {...props} />
}

export { Table, TableHeader, TableBody, TableRow, TableHead, TableCell }
