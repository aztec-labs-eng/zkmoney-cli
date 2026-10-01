import { Command } from "commander"
import { parseUnits } from "viem"
import { DEFAULT_DECIMALS } from "@obsidion/core/constants"
import { amount, fail, fields, note, print, shorten, table, when } from "../output.ts"
import { boot, type Runtime } from "../runtime/boot.ts"
import {
  createDeposit,
  getDepositView,
  listDepositViews,
  readDepositFacts,
  type DepositFacts,
  type DepositRequest,
  type DepositView,
} from "../runtime/deposits.ts"
import {
  fundingTokenNamed,
  recordAmount,
  requestWindowError,
  rescale,
} from "../runtime/depositFacts.ts"
import { Records } from "../runtime/records.ts"
import { RegistrationPendingError } from "../runtime/sponsor.ts"

type Globals = { home?: string; profile?: string; nodeUrl?: string; l1Rpc?: string }

async function withRuntime<T>(cmd: Command, run: (rt: Runtime) => Promise<T>): Promise<T> {
  const rt = await boot(cmd.optsWithGlobals<Globals>())
  try {
    return await run(rt)
  } finally {
    await rt.close()
  }
}

const accepts = (facts: DepositFacts) => facts.accepted.map((t) => t.symbol).join(", ")

function feeLine(facts: DepositFacts): string {
  const { symbol, decimals } = facts.token
  return `${amount(facts.fee, decimals, symbol)} (${amount(
    facts.sweepFee,
    decimals,
    symbol,
  )} sweep + ${amount(facts.fpcFundingCut, decimals, symbol)} portal cut), taken from what is sent`
}

const capLine = (facts: DepositFacts) =>
  `${amount(
    rescale(facts.cap, DEFAULT_DECIMALS, facts.token.decimals),
    facts.token.decimals,
    facts.token.symbol,
  )} credited per deposit`

/** The request as the user hands it out, checked against the window a sweep accepts. */
function resolveRequest(
  facts: DepositFacts,
  configured: string,
  opts: { asset?: string; amount?: string },
): { request: DepositRequest; line: string; warning?: string } {
  const explicit = opts.asset !== undefined
  const token =
    fundingTokenNamed(facts.accepted, opts.asset ?? configured) ??
    (explicit ? undefined : facts.token)
  if (!token) fail(`${opts.asset} is not accepted here`, `deposits here take ${accepts(facts)}`)
  let atomic: bigint | undefined
  if (opts.amount !== undefined) {
    if (!/^\d+(\.\d+)?$/.test(opts.amount) || Number(opts.amount) <= 0)
      fail(`"${opts.amount}" is not an amount`, "give a positive number like 25 or 12.50")
    atomic = parseUnits(opts.amount, token.decimals)
  }
  const warning =
    atomic === undefined
      ? undefined
      : requestWindowError(
          atomic,
          rescale(facts.fee, facts.token.decimals, token.decimals),
          facts.cap,
          token.decimals,
          token.symbol,
        )
  const line =
    atomic === undefined
      ? `any amount of ${token.symbol}`
      : amount(atomic, token.decimals, token.symbol)
  return {
    request: { asset: token.symbol, ...(opts.amount !== undefined ? { amount: opts.amount } : {}) },
    line,
    warning,
  }
}

function requestLine(view: DepositView): string | undefined {
  const request = view.slot?.request
  if (!request) return undefined
  return request.amount ? `${request.amount} ${request.asset}` : `any ${request.asset}`
}

function fundingLine(view: DepositView): string | undefined {
  if (view.readError) return `could not be read: ${view.readError}`
  if (!view.funding) return undefined
  const { token, balance, sweepable } = view.funding
  if (balance === 0n) return "nothing at the address"
  const held = amount(balance, token.decimals, token.symbol)
  return sweepable
    ? `${held} at the address, sweepable`
    : `${held} at the address, outside the sweep window`
}

export function depositsCommand(): Command {
  const cmd = new Command("deposits").description(
    "deposit addresses: create one to receive from Ethereum, then follow what lands there",
  )

  cmd
    .command("create")
    .description("a fresh deposit address, published so the relayer sweeps what is sent to it")
    .option("--asset <symbol>", "the token to ask for (default from config: defaults.asset)")
    .option("--amount <n>", "the amount to ask for, in that token")
    .option("--idempotency-key <key>", "reuse the address a run with this key already made")
    .option("--full", "print full addresses and hashes")
    .action(
      async (
        opts: { asset?: string; amount?: string; idempotencyKey?: string; full?: boolean },
        cmd: Command,
      ) => {
        await withRuntime(cmd, async (rt) => {
          const facts = await readDepositFacts(rt)
          const { request, line, warning } = resolveRequest(facts, rt.config.defaults.asset, opts)
          if (warning) note(`note: ${warning}; the request is shown as given`)
          const records = new Records(rt.storage)
          let created: Awaited<ReturnType<typeof createDeposit>>
          let replayed: boolean
          try {
            ;({ result: created, replayed } = await records.once(
              "deposit",
              opts.idempotencyKey,
              request,
              () => createDeposit(rt, request),
            ))
          } catch (err) {
            if (err instanceof RegistrationPendingError)
              fail(
                err.message,
                "the registered rail pays for the broadcast; try again in a few minutes",
              )
            throw err
          }
          if (replayed)
            note(`note: "${opts.idempotencyKey}" already made this address; nothing was sent`)
          else if (created.resumed)
            note("note: finished publishing an address an earlier run derived")
          const chain = rt.l1Chain.name
          print(
            fields([
              ["Address", created.address],
              ["Name", created.name],
              ["Send", `${line} to ${created.address} on ${chain}`],
              ["Accepts", accepts(facts)],
              ["Fee", feeLine(facts)],
              ["Cap", capLine(facts)],
              ["Published", `L2 tx ${shorten(created.txHash, opts.full)}`],
            ]),
          )
          print(
            "\nThe asset and amount are a request, not a rule: anything accepted that reaches the address is credited.",
          )
          print(
            "Next: `zkmoney watch` credits it as it lands; `zkmoney deposits get <address>` shows where it stands.",
          )
        })
      },
    )

  cmd
    .command("get <address>")
    .description("one deposit: its record, what sits at the address now, and why it waits")
    .option("--full", "print full addresses and hashes")
    .action(async (address: string, opts: { full?: boolean }, cmd: Command) => {
      if (!/^0x[0-9a-fA-F]{40}$/.test(address)) fail(`${address} is not an Ethereum address`)
      await withRuntime(cmd, async (rt) => {
        const found = await getDepositView(rt, address)
        if (!found) fail(`no deposit at ${address}`, "run `zkmoney deposits list`")
        const { facts, view } = found
        const { record } = view
        print(
          fields([
            ["Address", record.sipaAddress],
            ["Status", view.label],
            ["Requested", requestLine(view)],
            ["Recorded", recordAmount(record, facts.token.decimals)],
            ["At address", fundingLine(view)],
            [
              "Fee",
              record.fee
                ? amount(BigInt(record.fee), facts.token.decimals, facts.token.symbol)
                : undefined,
            ],
            [
              "From",
              record.fundingFromAddress ? shorten(record.fundingFromAddress, opts.full) : undefined,
            ],
            [
              "Funding tx",
              record.fundingTxHash ? shorten(record.fundingTxHash, opts.full) : undefined,
            ],
            ["Sweep tx", record.sweepTxHash ? shorten(record.sweepTxHash, opts.full) : undefined],
            [
              "Recovery tx",
              record.recoveryTxHash ? shorten(record.recoveryTxHash, opts.full) : undefined,
            ],
            [
              "Published",
              view.slot?.broadcastTxHash
                ? shorten(view.slot.broadcastTxHash, opts.full)
                : view.slot
                  ? "not yet"
                  : undefined,
            ],
            ["Created", when(record.startTime)],
            ["Settled", record.endTime ? when(record.endTime) : undefined],
            ["Error", record.error],
          ]),
        )
        if (view.label === "needs recovery")
          print(
            "\nThe funds cannot be swept from here; the web wallet's deposit detail offers the recovery.",
          )
      })
    })

  cmd
    .command("list")
    .description("every deposit address this account made or discovered, newest first")
    .option("--all", "include settled deposits")
    .option("--full", "print full addresses")
    .action(async (opts: { all?: boolean; full?: boolean }, cmd: Command) => {
      await withRuntime(cmd, async (rt) => {
        const { facts, views } = await listDepositViews(rt)
        const shown = opts.all
          ? views
          : views.filter((v) => !["credited", "recovered", "failed"].includes(v.label))
        if (!shown.length)
          return print(
            views.length ? "No open deposits; --all shows settled ones." : "No deposits yet.",
          )
        print(
          table(
            shown.map((v) => [
              shorten(v.record.sipaAddress, opts.full),
              v.label,
              v.funding && v.funding.balance > 0n
                ? amount(v.funding.balance, v.funding.token.decimals, v.funding.token.symbol)
                : (recordAmount(v.record, facts.token.decimals) ?? ""),
              requestLine(v) ?? "",
              when(v.record.startTime),
            ]),
            ["address", "status", "amount", "requested", "created"],
          ),
        )
        const total = views.length - shown.length
        if (total > 0) print(`\n${total} settled not shown; --all lists them.`)
      })
    })

  return cmd
}
