import { Command } from "commander"
import type { Transaction } from "../frontCore.ts"
import {
  amount,
  fail,
  fields,
  note,
  print,
  rpcRefusal,
  shorten,
  signed,
  table,
  time,
  when,
} from "../output.ts"
import { boot, type Runtime } from "../runtime/boot.ts"
import { syncDeposits } from "../runtime/deposits.ts"
import { openSync, type SyncHandle } from "../runtime/sync.ts"

type Globals = { home?: string; profile?: string; nodeUrl?: string; l1Rpc?: string }

async function withSync<T>(
  cmd: Command,
  run: (rt: Runtime, sync: SyncHandle) => Promise<T>,
): Promise<T> {
  const rt = await boot(cmd.optsWithGlobals<Globals>())
  let sync: SyncHandle | undefined
  try {
    sync = await openSync(rt)
    const handle = sync
    const tick = handle.tick.bind(handle)
    // Deposits are claimed on each tick, but a failed check must not hide the balance itself.
    handle.tick = async () => {
      try {
        const claimed = await syncDeposits(rt)
        if (claimed.failed)
          note(`note: ${claimed.failed} deposit claim(s) failed; they will be retried`)
      } catch (err) {
        note(`note: deposits were not checked: ${rpcRefusal(err) ?? (err as Error).message}`)
      }
      await tick()
    }
    return await run(rt, handle)
  } finally {
    sync?.stop()
    await rt.close()
  }
}

/** One line per history row: when, what, how much, who, hash, status. */
function txRow(tx: Transaction, decimals: number, symbol: string, full: boolean): string[] {
  const who = (tx as { toTag?: string; to?: string; from?: string }) ?? {}
  switch (tx.action) {
    case "send":
    case "receive": {
      const atomic = tx.amountAtomic
        ? BigInt(tx.amountAtomic)
        : BigInt(Math.round((tx.token?.amount ?? 0) * 10 ** decimals))
      const counterpart =
        tx.action === "send"
          ? (who.toTag ?? who.to ?? "")
          : who.from && !who.from.startsWith("0x")
            ? who.from
            : (tx.senderL2Address ?? who.from ?? "")
      return [
        when(tx.timestamp),
        tx.action,
        signed(tx.action === "send" ? -atomic : atomic, decimals, symbol),
        `${tx.action === "send" ? "to" : "from"} ${
          counterpart.startsWith("0x") ? shorten(counterpart, full) : counterpart
        }`,
        shorten(tx.txHash, full),
        tx.status,
      ]
    }
    case "Pay To Email":
    case "Claim With Email":
    case "Claim Back":
    case "Refunded":
    case "Claimed": {
      // The stored action words predate direct links; what the row did is the create, the claim, or
      // the creator taking an unclaimed link back.
      const created = tx.action === "Pay To Email"
      const kind = created ? "paylink" : tx.action === "Claim With Email" ? "claimed" : "reclaimed"
      const atomic = tx.token ? BigInt(Math.round(tx.token.amount * 10 ** decimals)) : undefined
      return [
        when(tx.timestamp),
        kind,
        atomic === undefined ? "" : signed(created ? -atomic : atomic, decimals, symbol),
        tx.memo ?? "",
        shorten(tx.txHash, full),
        created && tx.isRefunded ? "cancelled" : created && tx.isClaimed ? "claimed" : tx.status,
      ]
    }
    default:
      return [
        when(tx.timestamp),
        tx.action,
        "",
        tx.description ?? "",
        shorten(tx.txHash, full),
        tx.status,
      ]
  }
}

export function balanceCommand(): Command {
  return new Command("balance")
    .description("the private balance, after one sync")
    .action(async (_opts: unknown, cmd: Command) => {
      await withSync(cmd, async (rt, sync) => {
        await sync.tick()
        const balance = await sync.readBalance()
        if (balance === undefined)
          fail("the balance could not be read", "the node may be behind; try again")
        const head = await rt.node.getBlockNumber()
        print(
          fields([
            ["Balance", amount(balance, sync.token.decimals, sync.token.symbol)],
            ["As of", `block ${head}, ${time(Date.now())}`],
          ]),
        )
      })
    })
}

export function txsCommand(): Command {
  return new Command("txs")
    .description("transaction history, newest first")
    .option("-n, --limit <count>", "rows to show", "20")
    .option("--sent", "sends only")
    .option("--received", "receives only")
    .option("--full", "print full addresses and hashes")
    .action(
      async (
        opts: { limit: string; sent?: boolean; received?: boolean; full?: boolean },
        cmd: Command,
      ) => {
        await withSync(cmd, async (_rt, sync) => {
          await sync.tick()
          let rows = (await sync.list()).sort((a, b) => b.timestamp - a.timestamp)
          if (opts.sent) rows = rows.filter((t) => t.action === "send")
          if (opts.received) rows = rows.filter((t) => t.action === "receive")
          rows = rows.slice(0, Number(opts.limit))
          if (!rows.length) return print("No transactions yet.")
          print(
            table(rows.map((t) => txRow(t, sync.token.decimals, sync.token.symbol, !!opts.full))),
          )
        })
      },
    )
}

export function watchCommand(): Command {
  return new Command("watch")
    .description("keep syncing and print each balance change and transaction as it lands")
    .option("--interval <seconds>", "seconds between checks", "15")
    .option("--once", "sync once, print what changed, exit")
    .option("--full", "print full addresses and hashes")
    .action(async (opts: { interval: string; once?: boolean; full?: boolean }, cmd: Command) => {
      await withSync(cmd, async (_rt, sync) => {
        const seen = new Set<string>()
        let lastBalance: bigint | undefined
        const report = async (first: boolean) => {
          const balance = await sync.readBalance()
          if (balance !== undefined && balance !== lastBalance) {
            const delta =
              lastBalance === undefined
                ? ""
                : `  (${signed(balance - lastBalance, sync.token.decimals, sync.token.symbol)})`
            print(
              `${time(Date.now())}  balance  ${amount(
                balance,
                sync.token.decimals,
                sync.token.symbol,
              )}${delta}`,
            )
            lastBalance = balance
          }
          const rows = (await sync.list()).sort((a, b) => a.timestamp - b.timestamp)
          for (const tx of rows) {
            const key = `${tx.txHash}:${tx.status}`
            if (seen.has(key)) continue
            seen.add(key)
            if (first) continue
            const [, action, value, who, hash, status] = txRow(
              tx,
              sync.token.decimals,
              sync.token.symbol,
              !!opts.full,
            )
            print(`${time(Date.now())}  ${action.padEnd(8)} ${value} ${who}  ${hash}  ${status}`)
          }
        }
        await sync.tick()
        await report(true)
        if (opts.once) return
        print(`watching every ${opts.interval}s, Ctrl-C to stop`)
        const interval = Math.max(5, Number(opts.interval)) * 1000
        await new Promise<void>((resolve) => {
          const stop = () => {
            clearInterval(timer)
            resolve()
          }
          process.once("SIGINT", stop)
          process.once("SIGTERM", stop)
          const timer = setInterval(() => {
            sync
              .tick()
              .then(() => report(false))
              .catch((err: Error) => print(`${time(Date.now())}  sync failed: ${err.message}`))
          }, interval)
        })
      })
    })
}
