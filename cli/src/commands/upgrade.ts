import { join } from "node:path"
import { Command } from "commander"
import { DEFAULT_DECIMALS } from "@obsidion/core/constants"
import { OxidePortalContract } from "@oxide/l1-contracts/oxide_portal.js"
import type { Hex } from "viem"
import { amount, fail, fields, print, time } from "../output.ts"
import type { Runtime } from "../runtime/boot.ts"
import {
  generationV5Dir,
  startGenerationV5,
  type GenerationProcess,
  type GenerationSession,
} from "../runtime/upgrade/generation.ts"
import { phaseLine, runUpgrade, summaryLine } from "../runtime/upgrade/run.ts"
import { createUpgrade } from "../runtime/upgrade/session.ts"
import {
  previousGeneration,
  sourceDepositDescriptors,
  sourceLinkRows,
  type UpgradeSource,
} from "../runtime/upgrade/source.ts"
import { withRuntime } from "./withdraw.ts"

const dai = (atomic: bigint) => amount(atomic, DEFAULT_DECIMALS, "DAI")

interface OpenedSource {
  source: UpgradeSource
  generation: GenerationProcess
  session: GenerationSession
}

/** The old network, read through the v5 generation over the PXE this CLI kept for it. */
async function openSource(rt: Runtime): Promise<OpenedSource> {
  const source = await previousGeneration(rt)
  const portal = new OxidePortalContract(rt.l1 as never, source.tuple.portal as Hex)
  if (!(await portal.isFrozen()))
    fail(
      `the old network's portal ${source.tuple.portal} is not frozen yet`,
      "the upgrade opens once it is",
    )
  const { unlocked } = await rt.account()
  const auth = unlocked.authenticator
  const sign = (challenge: Uint8Array) => auth.sign(Buffer.from(challenge))
  const generation = await startGenerationV5(generationV5Dir(rt.config.generationV5Dir), sign)
  try {
    const session = await generation.open({
      account: {
        secretKey: unlocked.masterSecret.toString(),
        passkey: {
          publicKey: {
            x: `0x${auth.pubkeyX.toString("hex")}`,
            y: `0x${auth.pubkeyY.toString("hex")}`,
          },
          sign,
        },
      },
      nodeUrl: source.nodeUrl,
      nodeApiKey: source.nodeApiKey,
      l1RpcUrl: rt.config.l1RpcUrl.value,
      l1ChainId: rt.config.l1ChainId,
      network: rt.network,
      contracts: source.contracts,
      artifacts: source.artifacts,
      proverEnabled: true,
      pxeDataDirectory: join(source.dir, "pxe"),
    })
    return { source, generation, session }
  } catch (err) {
    generation.close()
    throw err
  }
}

/** What the old network still holds for the account, as its frozen portal can refund it. */
async function printHoldings(rt: Runtime, opened: OpenedSource): Promise<void> {
  const { unlocked } = await rt.account()
  const summary = await opened.session.frozenSummary({
    tuple: opened.source.tuple,
    depositDescriptors: () =>
      sourceDepositDescriptors(rt, opened.source, opened.session, unlocked.masterSecret),
    paylinkRows: () => sourceLinkRows(opened.source),
  })
  if (!summary) fail("the old network's portal is not frozen yet", "the upgrade opens once it is")
  print(
    fields([
      ["Old network", `${opened.source.profile.profileId}, portal ${opened.source.tuple.portal}`],
      ["Balance", dai(BigInt(summary.notes))],
      ["Open links", BigInt(summary.links) > 0n ? dai(BigInt(summary.links)) : undefined],
      ["Deposits", summary.deposits ? String(summary.deposits) : undefined],
      [
        "Waiting",
        summary.waiting
          ? `${summary.waiting} deposit(s) holding ${dai(BigInt(summary.waitingAmount))}, until their L1 block is final`
          : undefined,
      ],
    ]),
  )
}

export function upgradeCommand(): Command {
  const cmd = new Command("upgrade").description(
    "move the account from the old network to this one: its registration, then its funds",
  )
  cmd
    .option("--interval <seconds>", "seconds between checks while waiting", "10")
    .action(async (opts: { interval: string }, command: Command) => {
      await withRuntime(command, async (rt) => {
        const opened = await openSource(rt)
        try {
          await printHoldings(rt, opened)
          const { unlocked } = await rt.account()
          const upgrade = await createUpgrade(
            rt,
            opened.source,
            opened.generation,
            opened.session,
            unlocked.authenticator,
          )
          await upgrade.controller.load()
          const saved = upgrade.controller.getSnapshot()
          const quote = await upgrade.service.quote()
          if (!saved && quote.movable === 0n && !(await upgrade.service.needsMigration())) {
            print(
              "\nNothing to upgrade: the account's record is current and the old network holds nothing a refund can move.",
            )
            if (quote.stranded > 0n)
              print(
                `${dai(quote.stranded)} stays on the old network: below what a refund batch can move.`,
              )
            return
          }
          print("")
          print(
            fields([
              ["Moving", dai(quote.movable)],
              ["Batches", quote.batches ? String(quote.batches) : undefined],
              ["Approvals", String(quote.approvals ?? 0)],
              ["Stays behind", quote.stranded > 0n ? dai(quote.stranded) : undefined],
              ["Waiting", quote.waiting > 0n ? dai(quote.waiting) : undefined],
              ["Resuming", saved ? phaseLine(saved) : undefined],
            ]),
          )
          print("")
          const record = await runUpgrade(upgrade.controller, {
            summary: { fees: "0", approvals: quote.approvals ?? 0 },
            onLine: (line) => print(`${time(Date.now())}  ${line}`),
            pollMs: Math.max(1, Number(opts.interval)) * 1000,
          })
          print("")
          if (record?.phase === "done") print("Upgrade done: the funds landed on this network.")
          else if (record) {
            print(phaseLine(record))
            if (record.phase !== "arriving" && record.phase !== "waiting")
              print("`zkmoney upgrade` again resumes it.")
          }
        } finally {
          opened.generation.close()
        }
      })
    })

  cmd
    .command("status")
    .description("where the saved upgrade run stands, and what the old network still holds")
    .action(async (_opts: unknown, command: Command) => {
      await withRuntime(command, async (rt) => {
        const opened = await openSource(rt)
        try {
          await printHoldings(rt, opened)
          const { unlocked } = await rt.account()
          const upgrade = await createUpgrade(
            rt,
            opened.source,
            opened.generation,
            opened.session,
            unlocked.authenticator,
          )
          await upgrade.controller.load()
          const record = upgrade.controller.getSnapshot()
          print("")
          if (!record) {
            print("No upgrade run saved. `zkmoney upgrade` starts one.")
            return
          }
          print(
            fields([
              ["Run", phaseLine(record)],
              [
                "Approvals",
                record.approvals
                  ? `${record.approvals.approved} of ${record.approvals.total}`
                  : undefined,
              ],
              ["Quoted", record.summary ? summaryLine(record.summary) : undefined],
              ["Record update tx", record.bootstrapTx],
              ["Subscription tx", record.subscriptionTx],
              ["Error", record.error],
            ]),
          )
        } finally {
          opened.generation.close()
        }
      })
    })

  return cmd
}
