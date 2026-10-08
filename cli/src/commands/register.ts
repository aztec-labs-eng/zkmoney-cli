import { Command } from "commander"
import type { Address, Hex } from "viem"
import {
  composeWireNameHash,
  isTerminalRegistrationPhase,
  normalizeTag,
  resumeOxideRegistration,
  setLoggingEnabled,
  type PendingRegistrationRecord,
  type RegistrationBroadcastPayload,
} from "../frontCore.ts"
import { amount, fail, print, note, shorten, time } from "../output.ts"
import { boot, storagePath, type Runtime } from "../runtime/boot.ts"
import { Records } from "../runtime/records.ts"
import {
  L1_PRIVATE_KEY_ENV,
  broadcastOwed,
  fundRegistration,
  latestRegistration,
  loadRegistrationTerms,
  predictedL1Account,
  quoteForRecord,
  readRegistrationProgress,
  registrationContext,
  registrationKeysOf,
  registrationPublisher,
  rememberRegistered,
  resumeDeps,
  startRegistration,
  waitForRegistration,
  type RegistrationContext,
  type RegistrationKeys,
} from "../runtime/registration.ts"
import {
  fundedInFeeUnits,
  fundingSummary,
  renderDeposit,
  renderStatus,
} from "../runtime/registrationQuote.ts"

type Globals = { home?: string; profile?: string; nodeUrl?: string; l1Rpc?: string }

interface RegisterOpts {
  fund?: boolean
  wait?: boolean
  idempotencyKey?: string
  timeout: string
  full?: boolean
}

/** What a completed `register` leaves in the records store: enough to find the record again. */
interface RegisterResult {
  tag: string
  account: string
  sipaAddress: string
}

const stage = (label: string) => note(`${time(Date.now())}  ${label}`)

const STAGE_LABELS = {
  claim: "asking the account service to sign the claim",
  derive: "deriving the deposit address",
  broadcast: "publishing the address to relayers (this proves a transaction)",
} as const

type Ensured =
  | { kind: "registered"; account: string }
  | {
      kind: "pending"
      record: PendingRegistrationRecord
      resumed: boolean
      replayed: boolean
      /** The broadcast a session started here signed; the caller publishes it after printing. */
      payload?: RegistrationBroadcastPayload
    }

/**
 * The record for `tag`: resumed when one is live, else started. A live record for another tag is
 * replaced only while nothing reached its address and its broadcast never spent the account's
 * one-shot rail; past either, a new address could not register without a manual sweep.
 */
async function ensureRegistration(
  rt: Runtime,
  ctx: RegistrationContext,
  keys: RegistrationKeys,
  tag: string,
  idempotencyKey: string | undefined,
): Promise<Ensured> {
  const account = await predictedL1Account(ctx, keys)
  const nameHash = composeWireNameHash(tag, ctx.env.ensDomain)
  const prior = ctx.pending.get(account)
  const live = prior && !isTerminalRegistrationPhase(prior.phase) ? prior : undefined
  if (live && live.nameHash.toLowerCase() === nameHash.toLowerCase()) {
    return { kind: "pending", record: live, resumed: true, replayed: false }
  }
  let replaced: PendingRegistrationRecord | undefined
  if (live) {
    const held = await readRegistrationProgress(rt, ctx, live)
    if (live.fundedAt !== undefined || held.balances.some((b) => b.balance > 0n))
      fail(
        `@${live.tag} is still registering and its deposit address holds funds`,
        "wait for it with `zkmoney register status`, or finish it in the web wallet first",
      )
    if (live.broadcast || live.replaced?.broadcastSpent)
      fail(
        `@${live.tag} is still registering and the account's one-shot broadcast already went to its address`,
        `fund that address instead: zkmoney register ${live.tag}`,
      )
    note(`replacing the unfunded registration of @${live.tag}`)
    replaced = live
  }
  let payload: RegistrationBroadcastPayload | undefined
  let registered: string | undefined
  const { result, replayed } = await new Records(rt.storage).once<RegisterResult>(
    "register",
    idempotencyKey,
    { tag, l2Address: keys.account.getAddress().toString() },
    async () => {
      const { result } = await startRegistration(rt, ctx, keys, tag, {
        replaced,
        onStage: (s) => stage(STAGE_LABELS[s]),
      })
      switch (result.status) {
        case "taken":
          fail(
            result.reason === "blocked"
              ? `@${tag} is blocked and cannot be registered`
              : result.reason === "reserved"
                ? `@${tag} is reserved by someone else's live claim`
                : `@${tag} is already registered to another account`,
            "pick another tag",
          )
        case "already_registered":
          fail(
            result.name
              ? `this account already holds ${result.name}`
              : "this account already holds a name this wallet cannot map",
            "run `zkmoney account sync`",
          )
        case "registered":
          registered = result.oxideAccount
          return { tag, account: result.oxideAccount, sipaAddress: "" }
        case "awaiting_deposit":
          if (result.broadcastOwed) payload = result.payload
          return { tag, account: result.oxideAccount, sipaAddress: result.sipaAddress }
      }
    },
  )
  if (registered || !result.sipaAddress) return { kind: "registered", account: result.account }
  const record = ctx.pending.get(result.account)
  if (!record)
    fail(
      `the record for @${tag} is missing from ${storagePath(rt.config)}`,
      `run \`zkmoney register ${tag}\` again without the idempotency key`,
    )
  return { kind: "pending", record, resumed: false, replayed, payload }
}

async function printDeposit(
  rt: Runtime,
  ctx: RegistrationContext,
  record: PendingRegistrationRecord,
  full: boolean | undefined,
): Promise<void> {
  const terms = await loadRegistrationTerms(rt, record.account, record.tag)
  print(
    renderDeposit({
      tag: record.tag,
      ensDomain: ctx.env.ensDomain,
      sipaAddress: record.sipaAddress,
      chainName: rt.l1Chain.name,
      l1Account: record.account,
      feeToken: ctx.feeToken,
      fundingTokens: ctx.fundingTokens,
      quote: quoteForRecord(ctx, record, terms),
      holdDeadline: terms?.holdDeadline !== undefined ? terms.holdDeadline * 1000 : undefined,
      claimDeadline: terms?.claimDeadline ? terms.claimDeadline * 1000 : undefined,
      broadcast: record.broadcast,
      full,
    }),
  )
}

async function printStatus(
  rt: Runtime,
  ctx: RegistrationContext,
  record: PendingRegistrationRecord,
  full: boolean | undefined,
): Promise<void> {
  const progress = await readRegistrationProgress(rt, ctx, record)
  print(
    renderStatus({
      tag: record.tag,
      phase: record.phase,
      sipaAddress: record.sipaAddress,
      l1Account: record.account,
      feeToken: ctx.feeToken,
      balances: progress.balances,
      floor: progress.floor,
      swept: progress.swept,
      broadcast: record.broadcast,
      holdDeadline:
        progress.terms?.holdDeadline !== undefined ? progress.terms.holdDeadline * 1000 : undefined,
      registered: progress.registered,
      full,
    }),
  )
}

async function fund(
  rt: Runtime,
  ctx: RegistrationContext,
  record: PendingRegistrationRecord,
  full: boolean | undefined,
): Promise<void> {
  const key = process.env[L1_PRIVATE_KEY_ENV]
  if (!key) {
    print(
      `\n--fund needs ${L1_PRIVATE_KEY_ENV}, the hex private key of an L1 account holding ${ctx.feeToken.symbol}. Without it, send the amount above from any Ethereum wallet.`,
    )
    return
  }
  const progress = await readRegistrationProgress(rt, ctx, record)
  const held = fundedInFeeUnits(ctx.feeToken, progress.balances)
  if (progress.floor !== undefined && held >= progress.floor) {
    print(`\nThe deposit address already holds ${fundingSummary(progress.balances)}; nothing sent.`)
    return
  }
  const { total } = quoteForRecord(ctx, record, progress.terms)
  const { hash, from } = await fundRegistration(
    rt,
    ctx,
    record.sipaAddress as Address,
    total,
    key as Hex,
  )
  print(
    `\n${time(Date.now())}  sent ${amount(
      total,
      ctx.feeToken.decimals,
      ctx.feeToken.symbol,
    )} from ${shorten(from, full)}  ${hash}`,
  )
  const receipt = await rt.l1.waitForTransactionReceipt({ hash })
  if (receipt.status !== "success")
    fail(`the funding transfer reverted in block ${receipt.blockNumber}`)
  print(`${time(Date.now())}  mined in block ${receipt.blockNumber}`)
}

export function registerCommand(): Command {
  const cmd = new Command("register")
    .description("claim a tag: sign the claim, get the deposit address, fund it, wait for the name")
    .argument("<tag>", "the tag to register, with or without @")
    .option("--fund", `send the deposit from the L1 key in ${L1_PRIVATE_KEY_ENV}`)
    .option("--wait", "keep polling until the name is registered")
    .option("--idempotency-key <key>", "a key that returns this registration on a retry")
    .option("--timeout <minutes>", "how long --wait polls before giving up", "60")
    .option("--full", "print full addresses")
    .action(async (rawTag: string, opts: RegisterOpts, cmd: Command) => {
      setLoggingEnabled(Boolean(process.env.ZKMONEY_DEBUG))
      const tag = normalizeTag(rawTag)
      if (!tag)
        fail(
          `"${rawTag}" is not a tag the wallet can register`,
          "letters, digits and hyphens, with no hyphen at either end",
        )
      const rt = await boot(cmd.optsWithGlobals<Globals>())
      try {
        const keys = await registrationKeysOf(rt)
        const ctx = await registrationContext(rt)
        const ensured = await ensureRegistration(rt, ctx, keys, tag, opts.idempotencyKey)
        if (ensured.kind === "registered") {
          await rememberRegistered(rt, ctx, {
            account: ensured.account,
            tag,
            l2Address: keys.account.getAddress().toString() as Hex,
          })
          print(`@${tag} is already registered to ${shorten(ensured.account, opts.full)}.`)
          return
        }
        let { record } = ensured
        if (isTerminalRegistrationPhase(record.phase)) {
          if (record.phase === "confirmed") await rememberRegistered(rt, ctx, record)
          await printStatus(rt, ctx, record, opts.full)
          return
        }
        if (ensured.resumed) note(`@${tag} is already registering; resuming it`)
        if (ensured.replayed)
          note(
            `idempotency key "${opts.idempotencyKey}" was used before; this is that registration`,
          )
        await printDeposit(rt, ctx, record, opts.full)

        const publish = registrationPublisher(rt, ctx, keys, ensured.payload)
        if (broadcastOwed(record)) {
          stage(STAGE_LABELS.broadcast)
          stage(
            (await publish(record))
              ? "relayers notified"
              : "not published yet; the address stays valid and --wait keeps trying",
          )
        }
        record = ctx.pending.get(record.account) ?? record

        if (opts.fund) await fund(rt, ctx, record, opts.full)

        if (!opts.wait) return
        const timeoutMs = Math.max(1, Number(opts.timeout) || 60) * 60_000
        print(`\n${time(Date.now())}  waiting for the deposit and the sweep, Ctrl-C to stop`)
        const outcome = await waitForRegistration(rt, ctx, record, {
          timeoutMs,
          intervalMs: 10_000,
          onLine: (line) => print(`${time(Date.now())}  ${line}`),
          publish,
        })
        const final = ctx.pending.get(record.account) ?? record
        switch (outcome) {
          case "confirmed":
            await rememberRegistered(rt, ctx, final)
            print(
              `${time(Date.now())}  @${tag} is registered to ${shorten(final.account, opts.full)}`,
            )
            return
          case "taken":
            fail(`@${tag} went to another account before the deposit was swept`, "pick another tag")
          case "failed":
            fail(
              "the registration cannot go on from this record",
              `run \`zkmoney register status\`, then \`zkmoney register ${tag}\` again`,
            )
          case "needs_recovery":
            fail("the account holds a name this wallet cannot map", "run `zkmoney account sync`")
          case "timeout":
            fail(
              `nothing registered within ${opts.timeout} minutes`,
              "the address stays valid; `zkmoney register status` shows progress",
            )
        }
      } finally {
        await rt.close()
      }
    })

  cmd
    .command("status")
    .description("the pending registration: phase, deposit address, what arrived, registry state")
    .option("--full", "print full addresses")
    .action(async (opts: { full?: boolean }, cmd: Command) => {
      setLoggingEnabled(Boolean(process.env.ZKMONEY_DEBUG))
      const rt = await boot(cmd.optsWithGlobals<Globals>())
      try {
        const ctx = await registrationContext(rt)
        let record = latestRegistration(ctx)
        if (!record) {
          print("No registration in progress.")
          return
        }
        if (!isTerminalRegistrationPhase(record.phase)) {
          // Observes only: the registry read closes a swept record; nothing is signed here.
          const outcome = await resumeOxideRegistration(await resumeDeps(rt, ctx), {
            expectedRecord: { account: record.account, nameHash: record.nameHash },
          })
          record = ctx.pending.get(record.account) ?? record
          if (outcome === "confirmed") await rememberRegistered(rt, ctx, record)
        }
        await printStatus(rt, ctx, record, opts.full)
        if (!isTerminalRegistrationPhase(record.phase))
          print(`\n\`zkmoney register ${record.tag} --wait\` waits for it.`)
      } finally {
        await rt.close()
      }
    })

  return cmd
}
