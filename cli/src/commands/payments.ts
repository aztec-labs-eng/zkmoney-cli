import { Command } from "commander"
import { createNode } from "@obsidion/sdk"
import { loadConfig } from "../config.ts"
import { amount, fail, fields, print, shorten, table, when } from "../output.ts"
import { storagePath } from "../runtime/boot.ts"
import { Records } from "../runtime/records.ts"
import { PAYMENT_KIND, paymentStatus, type PaymentRecord } from "../runtime/send.ts"
import { FileStorageAdapter } from "../storage.ts"

type Globals = { home?: string; profile?: string; nodeUrl?: string; l1Rpc?: string }

/** The records and a node client, without a PXE: enough to read a payment back. */
async function open(cmd: Command) {
  const config = await loadConfig(cmd.optsWithGlobals<Globals>())
  return {
    records: new Records(new FileStorageAdapter(storagePath(config))),
    node: createNode(config.nodeUrl.value, config.nodeApiKey),
  }
}

export function paymentsCommand(): Command {
  const cmd = new Command("payments").description("payments this CLI sent, by id")

  cmd
    .command("get <id>")
    .description("one payment: its outcome on the chain, amount, recipient and hash")
    .option("--full", "print full addresses and hashes")
    .action(async (id: string, opts: { full?: boolean }, cmd: Command) => {
      const { records, node } = await open(cmd)
      const record = await records.get<PaymentRecord>(PAYMENT_KIND, id)
      if (!record) fail(`no payment "${id}"`, "`zkmoney payments list` shows the ids")
      const { status, detail } = await paymentStatus({ node }, record)
      const r = record.result
      print(
        fields([
          ["Payment", record.key],
          ["Status", detail ? `${status}: ${detail}` : status],
          ["Amount", r ? amount(BigInt(r.amountAtomic), r.decimals, r.symbol) : undefined],
          [
            "To",
            r ? (r.label.startsWith("0x") ? shorten(r.label, opts.full) : r.label) : undefined,
          ],
          ["Memo", r?.memo],
          ["Tx hash", r?.txHash ? shorten(r.txHash, opts.full) : undefined],
          ["Block", r?.blockNumber !== undefined ? String(r.blockNumber) : undefined],
          ["Created", when(record.createdAt)],
        ]),
      )
    })

  cmd
    .command("list")
    .description("every payment, newest first")
    .option("-n, --limit <count>", "rows to show", "20")
    .option("--full", "print full addresses and hashes")
    .action(async (opts: { limit: string; full?: boolean }, cmd: Command) => {
      const { records } = await open(cmd)
      const rows = (await records.list<PaymentRecord>(PAYMENT_KIND)).slice(0, Number(opts.limit))
      if (!rows.length) return print("No payments yet.")
      print(
        table(
          await Promise.all(
            rows.map(async (record) => {
              const r = record.result
              const { status } = await paymentStatus(undefined, record)
              return [
                when(record.createdAt),
                record.key,
                r ? amount(BigInt(r.amountAtomic), r.decimals, r.symbol) : "",
                r ? (r.label.startsWith("0x") ? shorten(r.label, opts.full) : r.label) : "",
                r?.txHash ? shorten(r.txHash, opts.full) : "",
                status,
              ]
            }),
          ),
          ["when", "id", "amount", "to", "tx", "status"],
        ),
      )
    })

  return cmd
}
