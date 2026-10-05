/**
 * The L2->L1 exit: a ClaimFPC-sponsored burn to an Ethereum address, direct in DAI or through
 * oxide's SwapEscrow for USDC, USDT and ETH. The burn is all this process sends; oxide's relayer
 * finalizes it on L1, and the tracking service walks the record through its phases from chain
 * reads, on this run or a later one. On mainnet the recipient is screened first, as the relayer
 * screens it again at batching time: a blocked address there is a burn that never releases.
 */
import { EthAddress } from "@aztec/aztec.js/addresses"
import { Fr } from "@aztec/aztec.js/fields"
import { TxHash } from "@aztec/stdlib/tx"
import { formatUnits, getAddress, isAddress, type Address, type Hex } from "viem"
import { DEFAULT_DECIMALS, WITHDRAW_RELAYER_TIP } from "@obsidion/core/constants"
import type { OxideEnvTuple } from "@obsidion/core/types"
import {
  L1SwapEscrowReader,
  L1WithdrawalFinalizationReader,
  SwapOnWithdrawSimulator,
  SwapTipExceedsInputError,
  fetchWithdrawalsWithIds,
  nextOperationId,
  planSwapOnWithdraw,
  readFpcFundingCut,
  readPortalWithdrawalState,
  type SwapOnWithdrawOutput,
  type SwapOnWithdrawPlan,
  type WithdrawalOptions,
} from "@obsidion/sdk"
import {
  ContactStorage,
  PredicateScreeningService,
  WITHDRAWAL_PHASE_COPY,
  WITHDRAWAL_TERMINAL_PHASES,
  WithdrawalStorage,
  WithdrawalTrackingService,
  createOxideL1Reader,
  deriveBootstrapKey,
  deriveSwapEscrowRecoverySalt,
  isWithdrawalDelayed,
  newWithdrawalLocalId,
  passThroughScreener,
  resolveOxideAccountFactory,
  resolveWithdrawalWiring,
  swapWithdrawalAmounts,
  trackWithdrawalSubmission,
  withdrawalAmounts,
  withdrawalRecipients,
  type AddressScreener,
  type Contact,
  type PredicateScreeningConfig,
  type WithdrawalDeployment,
  type WithdrawalRecord,
  type WithdrawalWiring,
} from "../frontCore.ts"
import { amount as formatAmount, fail, shorten, when } from "../output.ts"
import type { Runtime } from "./boot.ts"
import { quoteFasterProof, type FasterProof } from "./fasterProof.ts"
import { Records } from "./records.ts"
import { activateNetwork, parseSendAmount, refuseInterrupted, sponsorOrFail } from "./send.ts"
import { keysOf, noteSubscribed } from "./sponsor.ts"

export const WITHDRAWAL_KIND = "withdrawal"

export const WITHDRAW_ASSETS = ["DAI", "USDC", "USDT", "ETH"] as const
export type WithdrawAsset = (typeof WITHDRAW_ASSETS)[number]

export type WithdrawStage = "building" | "proving" | "submitting"

export function parseWithdrawAsset(text: string): WithdrawAsset {
  const asset = text.trim().toUpperCase()
  if (!(WITHDRAW_ASSETS as readonly string[]).includes(asset))
    fail(`"${text}" is not a withdrawal asset`, `one of: ${WITHDRAW_ASSETS.join(", ")}`)
  return asset as WithdrawAsset
}

/**
 * Predicate screening from the environment. Mainnet never runs unscreened, so a missing or
 * partial setup there is refused; elsewhere screening arms when the policy is set and passes
 * everything otherwise.
 */
export function predicateConfigFromEnv(
  env: Record<string, string | undefined>,
  network: string,
): PredicateScreeningConfig | undefined {
  const verificationHash = env.ZKMONEY_PREDICATE_VERIFICATION_HASH
  const chain = env.ZKMONEY_PREDICATE_CHAIN
  const apiKey = env.ZKMONEY_PREDICATE_API_KEY
  const missing = [
    !verificationHash && "ZKMONEY_PREDICATE_VERIFICATION_HASH",
    !chain && "ZKMONEY_PREDICATE_CHAIN",
    !apiKey && "ZKMONEY_PREDICATE_API_KEY",
  ].filter((m): m is string => !!m)
  if (missing.length === 3) {
    if (network === "mainnet")
      fail(
        "mainnet withdrawals need the recipient screened, and no screening is configured",
        "set ZKMONEY_PREDICATE_VERIFICATION_HASH, ZKMONEY_PREDICATE_CHAIN and ZKMONEY_PREDICATE_API_KEY to the policy oxide's relayer enforces",
      )
    return undefined
  }
  if (missing.length) fail(`screening is half configured: ${missing.join(", ")} missing`)
  return {
    verificationHash: verificationHash!,
    chain: chain!,
    apiKey,
    ...(env.ZKMONEY_PREDICATE_BASE_URL ? { baseUrl: env.ZKMONEY_PREDICATE_BASE_URL } : {}),
  }
}

export function screenerFor(rt: Runtime): AddressScreener {
  const config = predicateConfigFromEnv(process.env, rt.network)
  return config ? new PredicateScreeningService(config) : passThroughScreener
}

/** The oxide-rails coordinates a burn settles against; a manifest without them has no exit. */
export function withdrawalWiring(rt: Runtime): WithdrawalWiring {
  const wiring = resolveWithdrawalWiring(rt.tuple, BigInt(rt.config.l1ChainId))
  if (!wiring) fail("this deployment's manifest carries no withdrawal rails")
  return wiring
}

export function currentDeployment(rt: Runtime): WithdrawalDeployment {
  return { portal: withdrawalWiring(rt).portal, l2Token: rt.tuple.l2Token }
}

export const tuplePortal = (tuple: OxideEnvTuple, field: keyof OxideEnvTuple): Address => {
  const value = tuple[field]
  if (typeof value !== "string" || !value) fail(`oxide manifest lacks ${field}`)
  return value as Address
}

const cuts = new Map<string, Promise<bigint>>()

/** The portal's funding cut, an immutable read once per portal. */
export function fpcFundingCut(rt: Runtime): Promise<bigint> {
  const portal = tuplePortal(rt.tuple, "portal")
  let cut = cuts.get(portal.toLowerCase())
  if (!cut) {
    cut = readFpcFundingCut(rt.l1 as never, portal)
    cuts.set(portal.toLowerCase(), cut)
    cut.catch(() => cuts.delete(portal.toLowerCase()))
  }
  return cut
}

const trackers = new WeakMap<Runtime, Promise<WithdrawalTrackingService>>()

/** The chain watcher over the store, armed for every record it holds. Stop it before the process exits. */
export function withdrawalTracker(rt: Runtime): Promise<WithdrawalTrackingService> {
  let tracker = trackers.get(rt)
  if (!tracker) {
    tracker = (async () => {
      const wiring = withdrawalWiring(rt)
      const client = rt.l1 as never
      const readerFor = (d: { portal: Hex }) =>
        new L1WithdrawalFinalizationReader(client, { portal: d.portal })
      const service = WithdrawalTrackingService.get({
        store: WithdrawalStorage.get(rt.storage),
        node: rt.node,
        finalizationReader: readerFor(wiring),
        portalContext: wiring.portalContext,
        readerForDeployment: readerFor,
        swapEscrowReader: new L1SwapEscrowReader(client, { dai: tuplePortal(rt.tuple, "token") }),
      })
      await service.resumeAll()
      return service
    })()
    trackers.set(rt, tracker)
    tracker.catch(() => trackers.delete(rt))
  }
  return tracker
}

export interface WithdrawRecipient {
  address: Address
  /** The saved contact's name, when it was named by one. */
  alias?: string
}

const isL1Contact = (c: Contact) => c.addressKind === "ethereum-l1" && !c.l1Wallet?.deletedAt

/** The saved Ethereum contact `to` names. */
export function matchL1Contact(contacts: Contact[], to: string): Contact | undefined {
  const needle = to.trim().toLowerCase()
  return contacts.find((c) => isL1Contact(c) && c.name.toLowerCase() === needle)
}

export async function resolveWithdrawRecipient(
  rt: Runtime,
  to: string,
): Promise<WithdrawRecipient> {
  const text = to.trim()
  if (isAddress(text)) return { address: getAddress(text) }
  const contact = matchL1Contact(await ContactStorage.get(rt.storage).getEntries(), text)
  if (!contact)
    fail(
      `"${to}" is not an Ethereum address or a saved Ethereum contact`,
      "save one with `zkmoney contacts add <name> --eth <address>`",
    )
  return { address: getAddress(contact.address), alias: contact.name }
}

export interface WithdrawalFee {
  withdrawalRelayerTip: bigint
  fpcFundingCut: bigint
  /** Zero on the direct route. */
  swapRelayerTip: bigint
  /** Every deduction summed: what an amount has to clear to leave anything behind. */
  floorAtomic: bigint
}

export interface SwapCommit {
  relayerTip: bigint
  amountOut: bigint
  decimals: number
}

export interface WithdrawalQuote {
  asset: WithdrawAsset
  fee: WithdrawalFee
  /** The swap output for the exact amount, and the tip the escrow commits to. Absent on the direct route. */
  swap?: SwapCommit
}

/**
 * What a route costs. The direct route is the tip plus the portal's cut; a swap route also
 * simulates the relayer's run and prices its tip off that, so the quote is the one the escrow
 * commits to.
 */
export async function quoteWithdrawal(
  rt: Runtime,
  asset: WithdrawAsset,
  amountAtomic: bigint,
  recipient: Address,
): Promise<WithdrawalQuote> {
  const cut = await fpcFundingCut(rt)
  if (asset === "DAI") {
    return {
      asset,
      fee: {
        withdrawalRelayerTip: WITHDRAW_RELAYER_TIP,
        fpcFundingCut: cut,
        swapRelayerTip: 0n,
        floorAtomic: WITHDRAW_RELAYER_TIP + cut,
      },
    }
  }
  if (!rt.tuple.swapEscrowFactory)
    fail(`${asset} withdrawals are not available on ${rt.network}`, "withdraw DAI instead")
  if (amountAtomic <= WITHDRAW_RELAYER_TIP + cut)
    fail(
      `the amount does not cover the withdrawal fee of ${formatAmount(
        WITHDRAW_RELAYER_TIP + cut,
        DEFAULT_DECIMALS,
        "DAI",
      )}`,
    )
  const simulator = new SwapOnWithdrawSimulator(rt.l1 as never, {
    swapEscrowFactory: tuplePortal(rt.tuple, "swapEscrowFactory"),
    operationExecutor: tuplePortal(rt.tuple, "operationExecutor"),
    token: tuplePortal(rt.tuple, "token"),
  })
  const fee = (tip: bigint): WithdrawalFee => ({
    withdrawalRelayerTip: WITHDRAW_RELAYER_TIP,
    fpcFundingCut: cut,
    swapRelayerTip: tip,
    floorAtomic: WITHDRAW_RELAYER_TIP + cut + tip,
  })
  try {
    const simulation = await simulator.simulate({
      output: asset,
      amount: amountAtomic,
      deductions: { withdrawalRelayerTip: WITHDRAW_RELAYER_TIP, proverTip: 0n, fpcFundingCut: cut },
      recipient,
    })
    return {
      asset,
      fee: fee(simulation.relayerTip),
      swap: {
        relayerTip: simulation.relayerTip,
        amountOut: simulation.amountOut,
        decimals: simulation.decimals,
      },
    }
  } catch (err) {
    if (err instanceof SwapTipExceedsInputError) return { asset, fee: fee(err.tip.relayerTip) }
    throw err
  }
}

/** The swap leg, planned before the record exists so a bad manifest aborts with nothing persisted. */
export interface SwapLeg {
  output: SwapOnWithdrawOutput
  plan: SwapOnWithdrawPlan
  factory: Address
}

export async function planSwapLeg(
  rt: Runtime,
  quote: WithdrawalQuote,
  recipient: Address,
  amountAtomic: bigint,
): Promise<SwapLeg | undefined> {
  if (quote.asset === "DAI") return undefined
  if (!quote.swap) fail("the swap could not be priced", "withdraw DAI instead")
  tuplePortal(rt.tuple, "l2Broadcaster")
  const factory = tuplePortal(rt.tuple, "swapEscrowFactory")
  const keys = await keysOf(rt)
  const account = await createOxideL1Reader(rt.l1).predictAccountAddress(
    resolveOxideAccountFactory({ tuple: rt.tuple }),
    deriveBootstrapKey(keys.secretKey).address,
  )
  const nonce = Fr.random().toString() as Hex
  const plan = planSwapOnWithdraw({
    swapEscrowFactory: factory,
    output: quote.asset,
    l1Recipient: recipient,
    amount: amountAtomic,
    withdrawalRelayerTip: WITHDRAW_RELAYER_TIP,
    proverTip: 0n,
    fpcFundingCut: await fpcFundingCut(rt),
    relayerTip: quote.swap.relayerTip,
    recovery: {
      account: account as Address,
      salt: deriveSwapEscrowRecoverySalt(keys.secretKey, nonce),
    },
    nonce,
  })
  return { output: quote.asset, plan, factory }
}

/** How a burn settles: the deployment, the portal's state for the sdk's tip check, and the swap leg. */
export async function withdrawalOptions(rt: Runtime, swap?: SwapLeg): Promise<WithdrawalOptions> {
  const portal = await readPortalWithdrawalState(rt.l1 as never, tuplePortal(rt.tuple, "portal"))
  return { tuple: rt.tuple, portal, ...(swap ? { swap: swap.plan } : {}) }
}

function swapRecordFields(
  swap: SwapLeg | undefined,
  quote?: SwapCommit,
): Partial<WithdrawalRecord> {
  if (!swap) return {}
  return {
    swapOutput: swap.output,
    swapEscrow: swap.plan.escrow,
    swapEscrowFactory: swap.factory,
    swapRecoveryCommitment: swap.plan.escrowArgs.recoveryCommitment,
    swapNonce: swap.plan.escrowArgs.nonce,
    swapRelayerTip: swap.plan.escrowArgs.relayerTip.toString(),
    swapEstimatedOut: quote?.amountOut.toString(),
    swapOutputDecimals: quote?.decimals,
  }
}

/** The withdrawal a burn published, read from its tx effect: the amount and tip as the chain has them. */
async function publishedBurn(rt: Runtime, l2TxHash: string) {
  const { withdrawals } = await fetchWithdrawalsWithIds(
    rt.node,
    TxHash.fromString(l2TxHash),
    withdrawalWiring(rt).portalContext,
  )
  return withdrawals[0]
}

export interface BurnResult {
  txHash: string
  blockNumber: number
}

/**
 * One burn: seed the record, stamp its hash at submit, run the burn, mark it mined and arm the
 * watcher. A burn that may still land is returned unmined for the tracker; one that never went out
 * fails its record and rethrows.
 */
export async function runBurn(
  rt: Runtime,
  input: {
    operationId: string
    record: Omit<WithdrawalRecord, "localId" | "operationId">
    burn: (record: WithdrawalRecord) => Promise<BurnResult>
  },
): Promise<{ record: WithdrawalRecord; mined: boolean }> {
  const store = WithdrawalStorage.get(rt.storage)
  await store.load()
  const localId = newWithdrawalLocalId()
  const record = await store.create({ ...input.record, localId, operationId: input.operationId })
  const submission = trackWithdrawalSubmission(store, localId, input.operationId)
  let result: BurnResult
  try {
    result = await input.burn(record)
  } catch (err) {
    const pending = await submission.recover(rt.node)
    if (pending) {
      await withdrawalTracker(rt)
        .then((tracker) => tracker.watch(pending))
        .catch(() => {})
      return { record: pending, mined: false }
    }
    const message = err instanceof Error ? err.message : "Withdrawal failed"
    await store.patch(localId, { phase: "failed", error: message }).catch(() => {})
    throw err
  } finally {
    await submission.stop()
  }
  const published = await publishedBurn(rt, result.txHash).catch(() => undefined)
  let mined: WithdrawalRecord
  try {
    mined = await store.markMined(
      localId,
      result.txHash,
      result.blockNumber,
      published?.amount.toString() ?? record.rawAmount ?? "0",
      published?.relayerTip.toString() ?? record.relayerTip,
    )
  } catch {
    // Mined but not recorded as such: the tracker picks it up from the stamped hash.
    return { record: store.get(localId) ?? record, mined: true }
  }
  await withdrawalTracker(rt)
    .then((tracker) => tracker.watch(mined))
    .catch(() => {})
  return { record: mined, mined: true }
}

export interface WithdrawInput {
  amount: string
  to: string
  asset?: string
  key?: string
  /** Pay a prover tip for an early proof; DAI withdrawals only. */
  faster?: boolean
}

export interface WithdrawalHandle {
  localId: string
  operationId: string
  l2TxHash?: string
  /** `submitted`: the burn went out but its receipt was not seen; the tracker settles it. */
  outcome: "mined" | "submitted"
}

export const newWithdrawalId = () =>
  `wd-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`

export async function withdraw(
  rt: Runtime,
  input: WithdrawInput,
  onStage: (stage: WithdrawStage) => void,
): Promise<{
  id: string
  handle: WithdrawalHandle
  record: WithdrawalRecord
  replayed: boolean
  faster?: FasterProof
}> {
  const id = input.key ?? newWithdrawalId()
  const records = new Records(rt.storage)
  await refuseInterrupted(
    records,
    WITHDRAWAL_KIND,
    id,
    "check `zkmoney withdrawals list` for the earlier burn, then use a new key",
  )
  onStage("building")
  await activateNetwork(rt)
  const asset = parseWithdrawAsset(input.asset ?? rt.config.defaults.withdrawAsset)
  if (input.faster && asset !== "DAI")
    fail("only a DAI withdrawal can buy an early proof", "drop --asset or --faster")
  const tokenService = await rt.tokenService()
  const token = await tokenService.fetchTokenInformation()
  const amount = parseSendAmount(input.amount, token.decimals)
  const recipient = await resolveWithdrawRecipient(rt, input.to)
  const store = WithdrawalStorage.get(rt.storage)
  const args = { to: recipient.address, amount: amount.atomic.toString(), asset }
  const known = await records.get<WithdrawalHandle>(WITHDRAWAL_KIND, id)
  if (known?.result) {
    const done = known.result
    const replay = await records.once(WITHDRAWAL_KIND, id, args, async () => done)
    await store.load()
    const record = store.get(done.localId)
    if (!record) fail(`withdrawal "${id}" has no record in the store`)
    return { id, handle: done, record, replayed: replay.replayed }
  }
  const { unlocked, account } = await rt.account()
  // Screened at the commit point, before any record exists; a screener that cannot answer blocks.
  const verdict = await screenerFor(rt)
    .screen(recipient.address)
    .catch((err: unknown) =>
      fail(
        `the recipient could not be screened: ${err instanceof Error ? err.message : String(err)}`,
        "try again; a withdrawal to an unscreened address would burn and never release",
      ),
    )
  if (!verdict.compliant) fail(verdict.reason?.message ?? "this address cannot receive withdrawals")
  const quote = await quoteWithdrawal(rt, asset, amount.atomic, recipient.address)
  const faster = input.faster ? await quoteFasterProof(rt) : undefined
  const proverTip = faster?.proverTip ?? 0n
  if (amount.atomic <= quote.fee.floorAtomic + proverTip)
    fail(
      `the amount does not cover the fee of ${formatAmount(
        quote.fee.floorAtomic + proverTip,
        token.decimals,
        token.symbol,
      )}`,
    )
  const balance = await tokenService.getBalance()
  if (balance < amount.atomic)
    fail(
      `the balance is ${formatAmount(balance, token.decimals, token.symbol)}, below ${formatAmount(
        amount.atomic,
        token.decimals,
        token.symbol,
      )}`,
    )
  const handle = await records.once<WithdrawalHandle>(WITHDRAWAL_KIND, id, args, async () => {
    const sponsor = await sponsorOrFail(rt, unlocked.file.identity?.tag)
    const swap = await planSwapLeg(rt, quote, recipient.address, amount.atomic)
    const seed = { recipient: recipient.address, ...swapRecordFields(swap, quote.swap) }
    const exit = {
      l1Recipient: EthAddress.fromString(withdrawalRecipients(seed).release),
      amount: amount.atomic.toString(),
      withdrawal: await withdrawalOptions(rt, swap),
    }
    const operationId = nextOperationId("withdraw")
    const { record, mined } = await runBurn(rt, {
      operationId,
      record: {
        recipient: recipient.address,
        recipientProvenance: "saved-recipient",
        recipientAlias: recipient.alias,
        amount: formatUnits(amount.atomic, token.decimals),
        rawAmount: amount.atomic.toString(),
        relayerTip: WITHDRAW_RELAYER_TIP.toString(),
        proverTip: proverTip.toString(),
        fpcFundingCut: quote.fee.fpcFundingCut.toString(),
        tokenSymbol: token.symbol,
        phase: "submitting",
        startTime: Date.now(),
        deployment: currentDeployment(rt),
        ...swapRecordFields(swap, quote.swap),
      },
      burn: () => {
        onStage("proving")
        return tokenService.exitToL1PrivateSponsored(exit.l1Recipient, exit.amount, sponsor, {
          operationId,
          userAccount: account,
          useRawAmount: true,
          proverTip,
          withdrawal: exit.withdrawal,
        })
      },
    })
    if (mined && sponsor.subscribe) noteSubscribed(account, sponsor)
    onStage("submitting")
    return {
      localId: record.localId,
      operationId,
      l2TxHash: record.l2TxHash,
      outcome: mined ? "mined" : "submitted",
    }
  })
  await store.load()
  const record = store.get(handle.result.localId)
  if (!record) fail("the withdrawal record vanished after the burn")
  return { id, handle: handle.result, record, replayed: handle.replayed, faster }
}

/** A record by its idempotency key, its local id or its L2 tx hash. */
export async function findWithdrawal(
  rt: Pick<Runtime, "storage">,
  id: string,
): Promise<WithdrawalRecord | undefined> {
  const store = WithdrawalStorage.get(rt.storage)
  await store.load()
  const known = await new Records(rt.storage).get<WithdrawalHandle>(WITHDRAWAL_KIND, id)
  if (known?.result) return store.get(known.result.localId) ?? undefined
  return store.get(id) ?? undefined
}

/** The idempotency key each withdrawal was made under, by its store id. */
export async function withdrawalKeys(rt: Pick<Runtime, "storage">): Promise<Map<string, string>> {
  const records = await new Records(rt.storage).list<WithdrawalHandle>(WITHDRAWAL_KIND)
  return new Map(records.flatMap((r) => (r.result ? [[r.result.localId, r.key] as const] : [])))
}

export const isTerminal = (record: WithdrawalRecord) => WITHDRAWAL_TERMINAL_PHASES.has(record.phase)

export function phaseLabel(record: WithdrawalRecord, now = Date.now()): string {
  const copy = WITHDRAWAL_PHASE_COPY[record.phase]
  const status =
    record.phase === "submitting" && !record.l2TxHash ? (copy.proving ?? copy.status) : copy.status
  return isWithdrawalDelayed(record, now) ? `${status} (taking longer than usual)` : status
}

/** The lines `withdraw` and `withdrawals get` print for one record. */
export function withdrawalSummary(
  record: WithdrawalRecord,
  opts: { full?: boolean; now?: number } = {},
): [string, string | undefined][] {
  const amounts = withdrawalAmounts(record)
  const swap = swapWithdrawalAmounts(record)
  const symbol = record.tokenSymbol
  const fee = swap ?? amounts
  const to = record.recipientAlias
    ? `${record.recipientAlias} (${shorten(record.recipient, opts.full)})`
    : shorten(record.recipient, opts.full)
  return [
    ["Phase", `${record.phase}: ${phaseLabel(record, opts.now)}`],
    ["Amount", formatAmount(amounts.grossAtomic, DEFAULT_DECIMALS, symbol)],
    ["Fee", fee.feeKnown ? formatAmount(fee.feeAtomic, DEFAULT_DECIMALS, symbol) : undefined],
    [
      "Receives",
      swap
        ? swap.estimate
          ? `about ${formatAmount(
              swap.estimate.outAtomic,
              swap.estimate.outDecimals,
              record.swapOutput!,
            )}`
          : `${record.swapOutput}, amount set by the swap`
        : amounts.feeKnown
          ? formatAmount(amounts.netAtomic, DEFAULT_DECIMALS, symbol)
          : undefined,
    ],
    ["To", to],
    ["Escrow", record.swapEscrow ? shorten(record.swapEscrow, opts.full) : undefined],
    ["L2 tx", record.l2TxHash ? shorten(record.l2TxHash, opts.full) : undefined],
    ["L1 tx", record.l1TxHash ? shorten(record.l1TxHash, opts.full) : undefined],
    [
      "Swap tx",
      record.swapExecuteTxHash ? shorten(record.swapExecuteTxHash, opts.full) : undefined,
    ],
    ["Error", record.error],
    ["Started", when(record.startTime)],
    ["Ended", record.endTime !== undefined ? when(record.endTime) : undefined],
  ]
}

/**
 * Follow a record until it settles, reporting each phase change. This loop drives the tracker's
 * ticks itself. Ctrl-C stops the wait; the record keeps advancing on any later run.
 */
export async function waitForWithdrawal(
  rt: Runtime,
  localId: string,
  onPhase: (record: WithdrawalRecord) => void,
  intervalMs = 20_000,
): Promise<WithdrawalRecord> {
  const store = WithdrawalStorage.get(rt.storage)
  const tracker = await withdrawalTracker(rt)
  tracker.stop()
  let stopped = false
  let wake: (() => void) | undefined
  const stop = () => {
    stopped = true
    wake?.()
  }
  const sleep = (ms: number) =>
    new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        wake = undefined
        resolve()
      }, ms)
      wake = () => {
        clearTimeout(timer)
        wake = undefined
        resolve()
      }
    })
  process.once("SIGINT", stop)
  process.once("SIGTERM", stop)
  let last: string | undefined
  let record = store.get(localId)
  if (!record) fail(`no withdrawal ${localId}`)
  try {
    while (!stopped) {
      await tracker.syncOnce()
      record = store.get(localId) ?? record
      const key = `${record.phase}|${record.l1TxHash ?? ""}|${record.swapExecuteTxHash ?? ""}`
      if (key !== last) {
        last = key
        onPhase(record)
      }
      if (isTerminal(record)) break
      await sleep(intervalMs)
    }
    return record
  } finally {
    process.off("SIGINT", stop)
    process.off("SIGTERM", stop)
  }
}

/** Stop the watcher's timer so the process can exit. */
export async function stopTracking(rt: Runtime): Promise<void> {
  const tracker = trackers.get(rt)
  if (tracker) (await tracker.catch(() => undefined))?.stop()
}
