import { Command } from "commander"
import { amount, fields, note, print, shorten } from "../output.ts"
import { boot } from "../runtime/boot.ts"
import { sendPayment, type SendStage } from "../runtime/send.ts"

const STAGE_LINE: Record<SendStage, string> = {
  resolving: "resolving the recipient",
  proving: "proving and sending",
  submitting: "mined, saving the row",
}

export function sendCommand(): Command {
  return new Command("send")
    .description("pay a tag, a saved contact or an L2 address from the private balance")
    .argument("<amount>", "amount, like 12.50")
    .argument("[asset]", "DAI, the L2 asset")
    .requiredOption("--to <recipient>", "a tag, a saved contact's name, or a 0x L2 address")
    .option("--memo <text>", "a note the recipient sees")
    .option("--idempotency-key <key>", "a retry with the same key returns the same payment")
    .option("--full", "print full addresses and hashes")
    .action(
      async (
        amountText: string,
        asset: string | undefined,
        opts: { to: string; memo?: string; idempotencyKey?: string; full?: boolean },
        cmd: Command,
      ) => {
        const rt = await boot(cmd.optsWithGlobals())
        try {
          const { id, record, replayed } = await sendPayment(
            rt,
            { amount: amountText, to: opts.to, asset, memo: opts.memo, key: opts.idempotencyKey },
            (stage) => note(STAGE_LINE[stage]),
          )
          print(
            fields([
              ["Payment", id],
              ["Status", replayed ? "already sent under this key" : record.outcome],
              ["Amount", amount(BigInt(record.amountAtomic), record.decimals, record.symbol)],
              [
                "To",
                record.label.startsWith("0x") ? shorten(record.label, opts.full) : record.label,
              ],
              ["Memo", record.memo],
              ["Tx hash", record.txHash ? shorten(record.txHash, opts.full) : undefined],
              ["Block", record.blockNumber !== undefined ? String(record.blockNumber) : undefined],
            ]),
          )
          if (record.outcome === "submitted")
            print(`\nThe network has it; check with \`zkmoney payments get ${id}\`.`)
        } finally {
          await rt.close()
        }
      },
    )
}
