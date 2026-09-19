import { cn } from "@/lib/utils"

/**
 * Primitivos de tabela para as listagens admin. Sem paginação/estado embutido
 * de propósito — isso é do `Pagination` e do hook de query de cada tela;
 * este componente só cuida da apresentação.
 */

function Table({ className, ...props }: React.TableHTMLAttributes<HTMLTableElement>) {
  return (
    // `relative`: contém elementos `absolute` (ex.: `sr-only` num <th>) DENTRO do scroller — sem isso
    // eles escapam do `overflow-x-auto` e criam scroll horizontal na página inteira (achado em Carteiras, 390px).
    <div className="table-premium relative w-full overflow-x-auto rounded-xl border border-border-subtle">
      <table className={cn("w-full min-w-[640px] border-collapse text-sm", className)} {...props} />
    </div>
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
  return (
    <th
      className={cn(
        "whitespace-nowrap px-4 py-3 text-left text-[11px] font-bold uppercase tracking-wide text-ink-softer",
        className,
      )}
      {...props}
    />
  )
}

function TableCell({ className, ...props }: React.TdHTMLAttributes<HTMLTableCellElement>) {
  return <td className={cn("px-4 py-3 align-middle text-ink-soft", className)} {...props} />
}

export { Table, TableHeader, TableBody, TableRow, TableHead, TableCell }
