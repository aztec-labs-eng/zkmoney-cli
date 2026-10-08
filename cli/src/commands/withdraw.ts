import { Command } from "commander"
import { DEFAULT_DECIMALS } from "@obsidion/core/constants"
import { WithdrawalStorage, withdrawalAmounts } from "../frontCore.ts"
import { amount, fail, fields, note, print, shorten, table, time, when } from "../output.ts"
import { boot, type Runtime } from "../runtime/boot.ts"
import { fasterEta } from "../runtime/fasterProof.ts"
import {
  WITHDRAW_ASSETS,
  findWithdrawal,
  isTerminal,
  phaseLabel,
  withdrawalKeys,
  stopTracking,
  waitForWithdrawal,
  withdraw,
  withdrawalSummary,
  withdrawalTracker,
  type WithdrawStage,
} from "../runtime/withdraw.ts"

type Globals = { home?: string; profile?: string; nodeUrl?: string; l1Rpc?: string }

const STAGE_LINE: Record<WithdrawStage, string> = {
  building: "screening the recipient and pricing the exit",
  proving: "proving and sending the burn",
  submitting: "burn mined; oxide's relayer releases it on Ethereum",
}

async function withRuntime<T>(cmd: Command, run: (rt: Runtime) => Promise<T>): Promise<T> {
  const rt = await boot(cmd.optsWithGlobals<Globals>())
  try {
    return await run(rt)
  } finally {
    await stopTracking(rt)
    await rt.close()
  }
}

export function withdrawCommand(): Command {
  return new Command("withdraw")
    .description(
      "burn from the private balance to an Ethereum address; DAI direct, or swapped on arrival",
    )
    .argument("<amount>", "amount taken from the balance, fees included, like 250")
    .requiredOption("--to <recipient>", "an Ethereum address or a saved Ethereum contact's name")
    .option("--asset <asset>", `what arrives: ${WITHDRAW_ASSETS.join(", ")} (default from config)`)
    .option("--idempotency-key <key>", "a retry with the same key returns the same withdrawal")
    .option("--faster", "pay a DAI prover tip so the proof comes before its epoch ends")
    .option("--wait", "follow the withdrawal until the funds land on Ethereum")
    .option("--interval <seconds>", "seconds between checks while waiting", "20")
    .option("--full", "print full addresses and hashes")
    .action(
      async (
        amountText: string,
        opts: {
          to: string
          asset?: string
          idempotencyKey?: string
          faster?: boolean
          wait?: boolean
          interval: string
          full?: boolean
        },
        cmd: Command,
      ) => {
        await withRuntime(cmd, async (rt) => {
          const { id, handle, record, replayed, faster } = await withdraw(
            rt,
            {
              amount: amountText,
              to: opts.to,
              asset: opts.asset,
              key: opts.idempotencyKey,
              faster: opts.faster,
            },
            (stage) => note(STAGE_LINE[stage]),
          )
          print(
            fields([
              ["Withdrawal", id],
              ["Status", replayed ? "already sent under this key" : handle.outcome],
              ...withdrawalSummary(record, { full: opts.full }),
              ["Proof", faster ? fasterEta(faster) : undefined],
            ]),
          )
          if (!opts.wait || isTerminal(record)) {
            if (!isTerminal(record))
              print(`\nFollow it with \`zkmoney withdrawals get ${id}\` or \`--wait\`.`)
            return
          }
          print(`\nwaiting, Ctrl-C to stop`)
          const final = await waitForWithdrawal(
            rt,
            record.localId,
            (r) => print(`${time(Date.now())}  ${r.phase.padEnd(15)} ${phaseLabel(r)}`),
            Math.max(5, Number(opts.interval)) * 1000,
          )
          if (!isTerminal(final))
            print(`still ${final.phase}; \`zkmoney withdrawals get ${id}\` continues`)
        })
      },
    )
}

export function withdrawalsCommand(): Command {
  const cmd = new Command("withdrawals").description("withdrawals this CLI sent")

  cmd
    .command("get <id>")
    .description("one withdrawal by its id, local id or L2 tx hash, after one check of the chain")
    .option("--full", "print full addresses and hashes")
    .action(async (id: string, opts: { full?: boolean }, cmd: Command) => {
      await withRuntime(cmd, async (rt) => {
        let record = await findWithdrawal(rt, id)
        if (!record) fail(`no withdrawal "${id}"`, "`zkmoney withdrawals list` shows them")
        if (!isTerminal(record)) {
          await (await withdrawalTracker(rt)).syncOnce()
          record = (await findWithdrawal(rt, id)) ?? record
        }
        const key = (await withdrawalKeys(rt)).get(record.localId)
        print(fields([["Withdrawal", key ?? record.localId], ...withdrawalSummary(record, opts)]))
      })
    })

  cmd
    .command("list")
    .description("every withdrawal, newest first, after one check of the chain")
    .option("-n, --limit <count>", "rows to show", "20")
    .option("--full", "print full addresses and hashes")
    .action(async (opts: { limit: string; full?: boolean }, cmd: Command) => {
      await withRuntime(cmd, async (rt) => {
        const store = WithdrawalStorage.get(rt.storage)
        await store.load()
        if (store.list().some((r) => !isTerminal(r))) await (await withdrawalTracker(rt)).syncOnce()
        const rows = store
          .list()
          .sort((a, b) => b.startTime - a.startTime)
          .slice(0, Number(opts.limit))
        if (!rows.length) return print("No withdrawals yet.")
        const keys = await withdrawalKeys(rt)
        print(
          table(
            rows.map((r) => [
              when(r.startTime),
              keys.get(r.localId) ?? r.localId,
              amount(withdrawalAmounts(r).grossAtomic, DEFAULT_DECIMALS, r.tokenSymbol),
              r.swapOutput ?? r.tokenSymbol,
              r.recipientAlias ?? shorten(r.recipient, opts.full),
              r.l2TxHash ? shorten(r.l2TxHash, opts.full) : "",
              phaseLabel(r),
            ]),
            ["when", "id", "amount", "as", "to", "l2 tx", "phase"],
          ),
        )
      })
    })

  return cmd
}
