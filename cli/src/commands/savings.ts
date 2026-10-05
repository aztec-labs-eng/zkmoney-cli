import { Command } from "commander"
import { DEFAULT_DECIMALS } from "@obsidion/core/constants"
import { WithdrawalStorage } from "../frontCore.ts"
import { boot, type Runtime } from "../runtime/boot.ts"
import {
  moveThroughSky,
  readSavings,
  savingsRuntime,
  settleMoves,
  sharesFor,
  type SavingsMove,
} from "../runtime/savings.ts"
import { parseSendAmount } from "../runtime/send.ts"
import { phaseLabel, stopTracking, type WithdrawStage } from "../runtime/withdraw.ts"
import { amount, fields, note, print, shorten, table } from "../output.ts"

type Globals = { home?: string; profile?: string; nodeUrl?: string; l1Rpc?: string }

const STAGE_LINE: Record<WithdrawStage, string> = {
  building: "pricing the move",
  proving: "proving and sending the burn",
  submitting: "burn mined; oxide's relayer releases it and runs the escrow",
}

async function withSavings<T>(
  cmd: Command,
  run: (rt: Runtime, sv: Runtime) => Promise<T>,
): Promise<T> {
  const rt = await boot(cmd.optsWithGlobals<Globals>())
  try {
    return await run(rt, await savingsRuntime(rt))
  } finally {
    await stopTracking(rt)
    await rt.close()
  }
}

function moveRow(move: SavingsMove, burnPhase: string | undefined): string[] {
  const into = move.direction === "in"
  const state = move.deposit?.claimed
    ? "done"
    : move.deposit
    ? "deposited; claiming once it reaches L2"
    : burnPhase ?? "burn not recorded"
  return [
    into ? "Main to Savings" : "Savings to Main",
    amount(BigInt(move.amount), DEFAULT_DECIMALS, into ? "DAI" : "sUSDS"),
    shorten(move.escrow),
    state,
  ]
}

function moveCommand(direction: "in" | "out"): Command {
  const into = direction === "in"
  return new Command(into ? "add" : "to-main")
    .description(
      into
        ? "move DAI from the main balance into Sky savings"
        : "move savings back to the main balance, in DAI",
    )
    .argument(
      "<amount>",
      into ? "DAI taken from the main balance, fees included" : "USDS of savings to move back",
    )
    .option("--key <key>", "idempotency key: a retry with the same key never moves twice")
    .action(async (text: string, opts: { key?: string }, cmd: Command) => {
      await withSavings(cmd, async (rt, sv) => {
        const value = parseSendAmount(text, DEFAULT_DECIMALS).atomic
        const amountAtomic = into ? value : await sharesFor(sv, value)
        const { id, move, replayed } = await moveThroughSky(
          rt,
          sv,
          { direction, amountAtomic, key: opts.key },
          (stage) => note(STAGE_LINE[stage]),
        )
        print(
          fields([
            ["Move", id],
            ["Burned", amount(BigInt(move.amount), DEFAULT_DECIMALS, into ? "DAI" : "sUSDS")],
            ["Escrow", move.escrow],
            ["Escrow tip", amount(BigInt(move.escrowTip), DEFAULT_DECIMALS, "DAI")],
            ["Replayed", replayed ? "yes" : undefined],
          ]),
        )
        note("`zkmoney savings` shows its progress and claims it once it lands")
      })
    })
}

export function savingsCommand(): Command {
  return new Command("savings")
    .description("Sky savings: what the sUSDS balance is worth, the rate, and moves in flight")
    .action(async (_opts: unknown, cmd: Command) => {
      await withSavings(cmd, async (rt, sv) => {
        const moves = await settleMoves(rt, sv)
        const { shares, value, apy } = await readSavings(sv)
        print(
          fields([
            ["Savings", amount(value, DEFAULT_DECIMALS, "USDS")],
            ["Shares", amount(shares, DEFAULT_DECIMALS, "sUSDS")],
            ["Rate", apy === undefined ? "not published here" : `${(apy * 100).toFixed(2)}% APY`],
          ]),
        )
        const pending = moves.filter((move) => !move.deposit?.claimed)
        if (!pending.length) return
        const store = WithdrawalStorage.get(rt.storage)
        await store.load()
        print("")
        print(
          table(
            pending.map((move) => {
              const record = store.get(move.withdrawalLocalId)
              return moveRow(move, record ? phaseLabel(record) : undefined)
            }),
            ["Move", "Amount", "Escrow", "State"],
          ),
        )
      })
    })
    .addCommand(moveCommand("in"))
    .addCommand(moveCommand("out"))
}
