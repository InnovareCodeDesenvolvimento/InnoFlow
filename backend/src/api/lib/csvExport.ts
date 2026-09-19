import type { Response } from 'express'

/**
 * Exportação CSV dos relatórios (rotas 3,4,5,6 do módulo de retaguarda).
 * Convenção fixada pela Nova: `text/csv; charset=utf-8` + BOM UTF-8,
 * separador `;`, decimal com VÍRGULA (só no CSV — o JSON continua em
 * centavos/Wh inteiros), `Content-Disposition: attachment`, teto de 50 mil
 * linhas, streaming por cursor (nunca carregar tudo em memória).
 */
export const CSV_MAX_ROWS = 50_000
export const CSV_BATCH_SIZE = 1_000

/** Inícios que o Excel/LibreOffice interpretam como FÓRMULA (OWASP "CSV Injection"): `= + - @`, tab e CR. */
const FORMULA_TRIGGER = /^[=+\-@\t\r]/
/** Número puro (`-5`, `+12,50`, `-1234.56`) começa com `-`/`+` mas NÃO é fórmula — prefixar quebraria as colunas de dinheiro/energia negativas. */
const PLAIN_NUMBER = /^[+-]?\d+(?:[.,]\d+)?$/

/**
 * Neutraliza fórmula (Órion M2, 2026-09-19): uma célula que começa com `= + - @` tab ou CR ganha
 * um `'` na frente — a planilha passa a tratar como TEXTO. Sem isto, `driverName`/`actorName`/
 * `entityId` (controláveis por um motorista/atacante) como `=HYPERLINK("http://evil","x")` saíam
 * INTACTOS no CSV e executavam na planilha de quem exporta o relatório. Só o CSV: o JSON não muda.
 */
export function neutralizeFormula(str: string): string {
  return FORMULA_TRIGGER.test(str) && !PLAIN_NUMBER.test(str) ? `'${str}` : str
}

export function csvEscape(value: unknown): string {
  if (value === null || value === undefined) return ''
  const str = neutralizeFormula(String(value))
  if (/[;"\n\r]/.test(str)) return `"${str.replace(/"/g, '""')}"`
  return str
}

/** Centavos inteiros -> string decimal com vírgula (ex.: 123456 -> "1234,56"). Só para CSV. */
export function csvMoney(cents: number | null | undefined): string {
  if (cents === null || cents === undefined) return ''
  return (cents / 100).toFixed(2).replace('.', ',')
}

/** Wh inteiros -> kWh decimal com vírgula (ex.: 12345 -> "12,345"). Só para CSV. */
export function csvEnergyKwh(wh: number | null | undefined): string {
  if (wh === null || wh === undefined) return ''
  return (wh / 1000).toFixed(3).replace('.', ',')
}

export function csvPct(pct: number | null | undefined): string {
  if (pct === null || pct === undefined) return ''
  return pct.toFixed(2).replace('.', ',')
}

export function csvDecimal(value: number | null | undefined, digits = 2): string {
  if (value === null || value === undefined) return ''
  return value.toFixed(digits).replace('.', ',')
}

function sanitizeFilename(filename: string): string {
  return filename.replace(/[^a-zA-Z0-9_.-]/g, '-')
}

function startCsvResponse(res: Response, filename: string, headers: string[]): void {
  res.status(200)
  res.setHeader('Content-Type', 'text/csv; charset=utf-8')
  res.setHeader('Content-Disposition', `attachment; filename="${sanitizeFilename(filename)}"`)
  // BOM UTF-8 — Excel pt-BR não reconhece acentuação sem ele.
  res.write('﻿')
  res.write(headers.join(';') + '\r\n')
}

function writeCsvRow(res: Response, values: unknown[]): void {
  res.write(values.map(csvEscape).join(';') + '\r\n')
}

/**
 * Transmite um relatório em CSV buscando os dados em LOTES (`fetchBatch`),
 * nunca a tabela inteira de uma vez — corta em `CSV_MAX_ROWS` linhas mesmo
 * que o filtro devolvesse mais.
 */
export async function streamCsvReport<T>(
  res: Response,
  opts: { filename: string; headers: string[] },
  fetchBatch: (offset: number, limit: number) => Promise<T[]>,
  formatRow: (row: T) => unknown[],
  maxRows: number = CSV_MAX_ROWS,
  batchSize: number = CSV_BATCH_SIZE,
): Promise<void> {
  startCsvResponse(res, opts.filename, opts.headers)

  let offset = 0
  let total = 0
  for (;;) {
    if (total >= maxRows) break
    const limit = Math.min(batchSize, maxRows - total)
    const rows = await fetchBatch(offset, limit)
    if (rows.length === 0) break
    for (const row of rows) writeCsvRow(res, formatRow(row))
    total += rows.length
    offset += rows.length
    if (rows.length < limit) break
  }

  res.end()
}

/** Export de linha única (rotas com "summary" agregado, ex.: /reports/payments). */
export function streamCsvSingleRow(res: Response, opts: { filename: string; headers: string[] }, row: unknown[]): void {
  startCsvResponse(res, opts.filename, opts.headers)
  writeCsvRow(res, row)
  res.end()
}
