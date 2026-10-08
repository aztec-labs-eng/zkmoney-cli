import { Command } from "commander"
import { DEFAULT_DECIMALS } from "@obsidion/core/constants"
import { amount, fail, fields, note, print, shorten, table, time, when } from "../output.ts"
import type { Flags } from "../config.ts"
import { bootReadOnly } from "../runtime/boot.ts"
import {
  BRIDGES,
  BRIDGE_ASSETS,
  BRIDGE_NAMES,
  REQUOTE_NOTE,
  bridge,
  bridgeRoutes,
  bridgeState,
  bridgeSummary,
  bridgeView,
  listBridges,
  quoteBridgeTransfer,
  quoteSummary,
  recoverBridge,
  waitForBridge,
  type Bridge,
} from "../runtime/bridge.ts"
import { fasterEta } from "../runtime/fasterProof.ts"
import { L1_PRIVATE_KEY_ENV } from "../runtime/registration.ts"
import { resolveWithdrawRecipient, type WithdrawStage } from "../runtime/withdraw.ts"
import { withRuntime } from "./withdraw.ts"

const STAGE_LINE: Record<WithdrawStage, string> = {
  building: "pricing the bridge",
  proving: "proving and sending the burn",
  submitting: "burn mined; oxide's relayer releases it on Ethereum and runs the bridge",
}

export function bridgeCommand(): Command {
  return new Command("bridge")
    .description(
      "burn from the private balance and deliver USDC or USDT to an address on another chain",
    )
    .argument("<amount>", "DAI taken from the balance, fees included, like 250")
    .requiredOption("--to <recipient>", "an address or a saved Ethereum contact's name")
    .requiredOption(
      "--chain <chain>",
      "where it arrives, like base; `zkmoney bridges routes` lists them",
    )
    .option(
      "--asset <asset>",
      `what arrives: ${BRIDGE_ASSETS.join(" or ")} (default USDC where it goes)`,
    )
    .option("--via <bridge>", `${BRIDGES.join(" or ")} (default: whichever delivers more)`)
    .option("--idempotency-key <key>", "a retry with the same key returns the same bridge")
    .option("--faster", "pay a DAI prover tip so the proof comes before its epoch ends")
    .option("--wait", "follow it until it arrives")
    .option("--interval <seconds>", "seconds between checks while waiting", "20")
    .option("--full", "print full addresses and hashes")
    .action(
      async (
        amountText: string,
        opts: {
          to: string
          chain: string
          asset?: string
          via?: string
          idempotencyKey?: string
          faster?: boolean
          wait?: boolean
          interval: string
          full?: boolean
        },
        cmd: Command,
      ) => {
        await withRuntime(cmd, async (rt) => {
          const { id, transfer, replayed, faster } = await bridge(
            rt,
            {
              amount: amountText,
              to: opts.to,
              chain: opts.chain,
              asset: opts.asset,
              via: opts.via,
              key: opts.idempotencyKey,
              faster: opts.faster,
            },
            (stage) => note(STAGE_LINE[stage]),
          )
          const view = (await bridgeView(rt, id, { sync: false })) ?? { id, transfer }
          print(
            fields([
              ["Bridge", id],
              ["Replayed", replayed ? "already sent under this key" : undefined],
              ...bridgeSummary(view, { full: opts.full }),
              ["Proof", faster ? fasterEta(faster) : undefined],
            ]),
          )
          if (bridgeState(view).settled) return
          if (!opts.wait)
            return print(`\nFollow it with \`zkmoney bridges get ${id}\` or \`--wait\`.`)
          print(`\nwaiting, Ctrl-C to stop`)
          const final = await waitForBridge(
            rt,
            id,
            (v) => print(`${time(Date.now())}  ${bridgeState(v).label}`),
            Math.max(5, Number(opts.interval)) * 1000,
          )
          if (!bridgeState(final).settled) print(`\`zkmoney bridges get ${id}\` continues`)
        })
      },
    )
}

export function bridgesCommand(): Command {
  const cmd = new Command("bridges").description("bridges this CLI sent, and where the bridges go")

  cmd
    .command("get <id>")
    .description("one bridge by its id, after one check of the chain and the bridge")
    .option("--full", "print full addresses and hashes")
    .action(async (id: string, opts: { full?: boolean }, cmd: Command) => {
      await withRuntime(cmd, async (rt) => {
        const view = await bridgeView(rt, id)
        if (!view) fail(`no bridge "${id}"`, "`zkmoney bridges list` shows them")
        print(fields([["Bridge", id], ...bridgeSummary(view, opts)]))
      })
    })

  cmd
    .command("list")
    .description("every bridge, newest first, after one check of the chain and the bridges")
    .option("-n, --limit <count>", "rows to show", "20")
    .option("--full", "print full addresses and hashes")
    .action(async (opts: { limit: string; full?: boolean }, cmd: Command) => {
      await withRuntime(cmd, async (rt) => {
        const views = (await listBridges(rt)).slice(0, Number(opts.limit))
        if (!views.length) return print("No bridges yet.")
        print(
          table(
            views.map((view) => [
              view.record ? when(view.record.startTime) : "",
              view.id,
              amount(BigInt(view.transfer.amount), DEFAULT_DECIMALS, "DAI"),
              `${view.transfer.asset} to ${view.transfer.chain}`,
              BRIDGE_NAMES[view.transfer.bridge],
              view.transfer.recipientAlias ?? shorten(view.transfer.recipient, opts.full),
              bridgeState(view).label,
            ]),
            ["when", "id", "amount", "as", "via", "to", "state"],
          ),
        )
      })
    })

  cmd
    .command("quote <amount>")
    .description(
      "price a bridge and send nothing: each fee, what arrives, and how long the proof takes",
    )
    .requiredOption("--to <address>", "the recipient's address on the destination chain")
    .requiredOption(
      "--chain <chain>",
      "where it arrives, like base; `zkmoney bridges routes` lists them",
    )
    .option(
      "--asset <asset>",
      `what arrives: ${BRIDGE_ASSETS.join(" or ")} (default USDC where it goes)`,
    )
    .option("--via <bridge>", `${BRIDGES.join(" or ")} (default: whichever delivers more)`)
    .option("--faster", "include a DAI prover tip for an early proof")
    .option("--full", "print full addresses")
    .action(
      async (
        amountText: string,
        opts: {
          to: string
          chain: string
          asset?: string
          via?: string
          faster?: boolean
          full?: boolean
        },
        cmd: Command,
      ) => {
        const rt = await bootReadOnly(cmd.optsWithGlobals<Flags>())
        const quoted = await quoteBridgeTransfer(rt, { ...opts, amount: amountText })
        const { facts, items, proof } = quoteSummary(quoted, opts)
        print(fields(facts))
        print(`\n${table(items)}\n`)
        print(fields([["Proof", proof]]))
        print(`\n${REQUOTE_NOTE}`)
      },
    )

  cmd
    .command("routes")
    .description("every chain the bridges reach, and what each delivers there")
    .action(() => {
      const chains = new Map<string, Record<Bridge, string[]>>()
      for (const route of bridgeRoutes()) {
        const via = chains.get(route.chain) ?? { across: [], cctp: [] }
        via[route.bridge].push(route.asset)
        chains.set(route.chain, via)
      }
      print(
        table(
          [...chains]
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([chain, via]) => [chain, via.across.join(", "), via.cctp.join(", ")]),
          ["chain", "across", "cctp"],
        ),
      )
    })

  cmd
    .command("recover <id>")
    .description(
      "free a bridge's escrow: run it yourself if nobody did, or send what it holds to an Ethereum address",
    )
    .option(
      "--to <recipient>",
      "send the escrow's funds here instead: an address or a saved contact",
    )
    .action(async (id: string, opts: { to?: string }, cmd: Command) => {
      const privateKey = process.env[L1_PRIVATE_KEY_ENV]
      if (!privateKey)
        fail(
          `set ${L1_PRIVATE_KEY_ENV} to an Ethereum key that pays the gas`,
          "running the escrow pays that key the escrow's tip",
        )
      await withRuntime(cmd, async (rt) => {
        const to = opts.to ? (await resolveWithdrawRecipient(rt, opts.to)).address : undefined
        const { txHashes } = await recoverBridge(rt, { id, to }, privateKey as `0x${string}`)
        print(
          fields([
            ["Bridge", id],
            ["Outcome", to ? `escrow funds sent to ${to}` : "escrow run; the bridge delivers next"],
            ["Transactions", txHashes.join(", ")],
          ]),
        )
      })
    })

  return cmd
}
