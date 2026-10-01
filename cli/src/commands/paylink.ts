import { Command } from "commander"
import { parseUnits } from "viem"
import { DEFAULT_DECIMALS } from "@obsidion/core/constants"
import { PAYLINK_STATUS_LABEL } from "../frontCore.ts"
import { amount, fields, note, print, shorten } from "../output.ts"
import { boot, type Runtime } from "../runtime/boot.ts"
import {
  DEFAULT_CLAIM_WINDOW_DAYS,
  cancelPaylink,
  claimPaylink,
  createPaylink,
  viewPaylink,
  type PaylinkStage,
} from "../runtime/paylink.ts"

type Globals = { home?: string; profile?: string; nodeUrl?: string; l1Rpc?: string }

const STAGE_LINE: Record<PaylinkStage, string> = {
  building: "reading the chain",
  proving: "proving and sending",
  submitting: "mined, saving the row",
}

async function withRuntime<T>(cmd: Command, run: (rt: Runtime) => Promise<T>): Promise<T> {
  const rt = await boot(cmd.optsWithGlobals<Globals>())
  try {
    return await run(rt)
  } finally {
    await rt.close()
  }
}

const untilLine = (untilSec: number, nowSec: number): string => {
  const left = untilSec - nowSec
  const at = new Date(untilSec * 1000).toLocaleString()
  if (left <= 0) return `${at} (expired)`
  const days = Math.floor(left / 86_400)
  const hours = Math.floor((left % 86_400) / 3_600)
  return `${at} (${days ? `${days}d ` : ""}${hours}h left)`
}

export function paylinkCommand(): Command {
  const cmd = new Command("paylink").description("payment links: create, check, claim, cancel")

  cmd
    .command("create <amount>")
    .description("fund a link anyone can claim into their wallet")
    .option("--memo <text>", "a note the claimer sees")
    .option("--expires <days>", "days the link stays claimable", String(DEFAULT_CLAIM_WINDOW_DAYS))
    .option("--idempotency-key <key>", "a retry with the same key returns the same link")
    .option("--no-voucher", "do not gift the claimer a sponsored transaction")
    .option("--full", "print full hashes")
    .action(
      async (
        amountText: string,
        opts: {
          memo?: string
          expires: string
          idempotencyKey?: string
          voucher: boolean
          full?: boolean
        },
        cmd: Command,
      ) => {
        await withRuntime(cmd, async (rt) => {
          const { id, record, replayed } = await createPaylink(
            rt,
            {
              amount: amountText,
              memo: opts.memo,
              expiryDays: Number(opts.expires),
              key: opts.idempotencyKey,
              voucher: opts.voucher,
            },
            (stage) => note(STAGE_LINE[stage]),
          )
          print(
            fields([
              ["Link", record.url],
              ["Id", id],
              ["Status", replayed ? "already created under this key" : record.outcome],
              ["Amount", amount(BigInt(record.amountAtomic), record.decimals, record.symbol)],
              ["Memo", record.memo],
              ["Claimable until", new Date(record.untilClaimable * 1000).toLocaleString()],
              [
                "Voucher",
                record.voucher === undefined
                  ? undefined
                  : record.voucher
                    ? "yes, a claimer without a tag can claim it"
                    : "no, the claimer needs a registered tag",
              ],
              ["Funding tx", record.txHash ? shorten(record.txHash, opts.full) : undefined],
            ]),
          )
          print("\nAnyone with the link can claim it; share it over a private channel.")
        })
      },
    )

  cmd
    .command("status <id-or-link>")
    .description("what the chain says about a link, and what its creator can still do")
    .option("--full", "print full hashes")
    .action(async (text: string, opts: { full?: boolean }, cmd: Command) => {
      await withRuntime(cmd, async (rt) => {
        const view = await viewPaylink(rt, text)
        const creator = view.creator
        const status = creator
          ? PAYLINK_STATUS_LABEL[creator.status].toLowerCase()
          : view.spent
            ? "claimed or cancelled"
            : view.note && view.chainNow > view.note.claimableUntil
              ? "expired"
              : view.note && view.chainNow < view.note.claimableFrom
                ? `unclaimed, opens in ${view.note.claimableFrom - view.chainNow}s`
                : "unclaimed"
        print(
          fields([
            ["Link", view.url],
            ["Status", status],
            [
              "Amount",
              view.note
                ? amount(view.note.amount, DEFAULT_DECIMALS, creator?.row.token?.symbol ?? "DAI")
                : creator?.row.token
                  ? amount(
                      parseUnits(String(creator.row.token.amount), creator.row.token.decimals),
                      creator.row.token.decimals,
                      creator.row.token.symbol,
                    )
                  : undefined,
            ],
            ["Memo", view.memo ?? creator?.row.memo],
            [
              "Claimable until",
              view.note
                ? untilLine(view.note.claimableUntil, view.chainNow)
                : creator?.row.untilClaimable
                  ? untilLine(creator.row.untilClaimable, view.chainNow)
                  : undefined,
            ],
            ["Funding tx", view.fundingTxHash ? shorten(view.fundingTxHash, opts.full) : undefined],
            [
              "Refund tx",
              creator?.row.refundTxHash ? shorten(creator.row.refundTxHash, opts.full) : undefined,
            ],
            ["Created by", creator ? "this account" : undefined],
            [
              "You can",
              creator?.action === "cancel"
                ? "cancel it: `zkmoney paylink cancel <id>`"
                : creator?.action === "reclaim"
                  ? "reclaim the funds: `zkmoney paylink cancel <id>`"
                  : undefined,
            ],
          ]),
        )
      })
    })

  cmd
    .command("claim <link>")
    .description("claim a link into this wallet")
    .option("--full", "print full hashes")
    .action(async (link: string, opts: { full?: boolean }, cmd: Command) => {
      await withRuntime(cmd, async (rt) => {
        const result = await claimPaylink(rt, link, (stage) => note(STAGE_LINE[stage]))
        print(
          fields([
            ["Status", result.outcome],
            [
              "Amount",
              result.amountAtomic
                ? amount(BigInt(result.amountAtomic), DEFAULT_DECIMALS, "DAI")
                : "unknown until the note syncs",
            ],
            ["Tx hash", shorten(result.txHash, opts.full)],
          ]),
        )
      })
    })

  cmd
    .command("cancel <id-or-link>")
    .description("take an unclaimed link's funds back")
    .option("--full", "print full hashes")
    .action(async (text: string, opts: { full?: boolean }, cmd: Command) => {
      await withRuntime(cmd, async (rt) => {
        const result = await cancelPaylink(rt, text, (stage) => note(STAGE_LINE[stage]))
        print(
          fields([
            ["Status", result.outcome],
            ["Recovery", result.kind === "cancel" ? "cancelled" : "reclaimed after expiry"],
            ["Tx hash", shorten(result.txHash, opts.full)],
          ]),
        )
      })
    })

  return cmd
}
