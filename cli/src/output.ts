/** Terminal output: plain lines a person reads, stable enough for a script to grep. */
import { formatUnits } from "viem"

export const shorten = (value: string, full = false): string =>
  full || value.length <= 14 ? value : `${value.slice(0, 6)}…${value.slice(-4)}`

export function amount(atomic: bigint, decimals: number, symbol: string, places = 2): string {
  const [whole, frac = ""] = formatUnits(atomic, decimals).split(".")
  const shown = frac.padEnd(places, "0").slice(0, places)
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",")
  return `${grouped}.${shown} ${symbol}`
}

export function signed(atomic: bigint, decimals: number, symbol: string): string {
  const sign = atomic < 0n ? "-" : "+"
  return `${sign}${amount(atomic < 0n ? -atomic : atomic, decimals, symbol)}`
}

export const time = (ms: number): string =>
  new Date(ms).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })

export const when = (ms: number): string => {
  const d = new Date(ms)
  const today = new Date()
  const sameDay = d.toDateString() === today.toDateString()
  return sameDay
    ? time(ms)
    : d.toLocaleDateString(undefined, { day: "numeric", month: "short" }) + " " + time(ms)
}

/** Two-column list: labels padded to the widest one. */
export function fields(rows: [string, string | undefined][]): string {
  const shown = rows.filter((r): r is [string, string] => r[1] !== undefined && r[1] !== "")
  const width = Math.max(...shown.map(([k]) => k.length), 0)
  return shown.map(([k, v]) => `${k.padEnd(width)}   ${v}`).join("\n")
}

/** Rows of cells, each column padded to its widest cell; right-aligns cells that look numeric. */
export function table(rows: string[][], header?: string[]): string {
  const all = header ? [header, ...rows] : rows
  const widths: number[] = []
  for (const row of all)
    row.forEach((cell, i) => (widths[i] = Math.max(widths[i] ?? 0, cell.length)))
  const numeric = (s: string) => /^[+-]?[\d,]+(\.\d+)?( [A-Z]+)?$/.test(s)
  const line = (row: string[]) =>
    row
      .map((cell, i) =>
        numeric(cell) && !(header && row === header)
          ? cell.padStart(widths[i]!)
          : cell.padEnd(widths[i]!),
      )
      .join("  ")
      .trimEnd()
  const out = all.map(line)
  if (header) out.splice(1, 0, widths.map((w) => "-".repeat(w)).join("  "))
  return out.join("\n")
}

export class CliError extends Error {
  constructor(
    message: string,
    readonly hint?: string,
  ) {
    super(message)
  }
}

export function fail(message: string, hint?: string): never {
  throw new CliError(message, hint)
}

type Failure = { name?: string; url?: string; status?: number; details?: string; cause?: unknown }

/** An Ethereum RPC's refusal anywhere in an error's causes, as one readable line. */
export function rpcRefusal(err: unknown): string | undefined {
  for (let e = err as Failure | undefined; e; e = e?.cause as Failure | undefined) {
    if (e.name !== "HttpRequestError" || !e.url) continue
    let host = e.url
    try {
      host = new URL(e.url).host
    } catch {}
    let details = e.details
    try {
      details = JSON.parse(details ?? "").message ?? details
    } catch {}
    return `${host} refused the request${e.status ? ` (HTTP ${e.status})` : ""}${
      details ? `: ${details}` : ""
    }`
  }
  return undefined
}

export function print(text: string): void {
  process.stdout.write(text.endsWith("\n") ? text : text + "\n")
}

export function note(text: string): void {
  process.stderr.write(text.endsWith("\n") ? text : text + "\n")
}
