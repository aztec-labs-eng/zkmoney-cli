/**
 * Direct payment links: an escrow this account funds that whoever holds the link claims, with the
 * ClaimFPC sponsoring both legs. The link is a bearer secret and carries no amount; chain says what
 * the escrow holds. The creator's history row keeps the refund material, so a cancel needs only the
 * link and the keys. Email-locked links are not handled here.
 */
import { AztecAddress } from "@aztec/stdlib/aztec-address"
import type { Fr } from "@aztec/aztec.js/fields"
import { formatUnits } from "viem"
import {
  DEFAULT_CONTRACTS,
  PAYLINK_CANCEL_MARGIN_SECONDS,
  PAYLINK_GRACE_PERIOD_SECONDS,
  QueueStatus,
  SECONDS_IN_A_DAY,
} from "@obsidion/core/constants"
import {
  PaylinkClaimReconciler,
  PaylinkWindowClosedError,
  TransactionStorage,
  TxLifecycleService,
  checkSpentViaPaylinkService,
  isPaylinkInRefundWindow,
  paylinkRefundEligibility,
  paylinkStatusFor,
  paylinkWindows,
  readPaylinkNote,
  trackSubmission,
  type PaylinkStatusKind,
  type PaylinkTransaction,
  type SubmissionTracker,
} from "../frontCore.ts"
import {
  PaylinkActionEnum,
  PaylinkService,
  UnknownRailError,
  decodePaylinkInline,
  encodePaylinkInline,
  nextOperationId,
  paylinkVoucherUses,
  type ClaimSponsorContext,
  type ObsidionAccount,
  type PaylinkNoteView,
  type PaylinkParams,
  type TokenService,
  claimFpcSubscriptionUses,
} from "@obsidion/sdk"
import { fail } from "../output.ts"
import type { Runtime } from "./boot.ts"
import { Records } from "./records.ts"
import { activateNetwork, parseSendAmount, refuseInterrupted, sponsorOrFail } from "./send.ts"
import { claimSponsorRail, noteSubscribed, RAIL_REGISTERED, RAIL_VOUCHER } from "./sponsor.ts"
import { requireTeeSigner } from "./tee.ts"

export const PAYLINK_KIND = "paylink"
/** Entered by gift alone: one sponsored claim the creator handed the link's escrow. */
/** How long a link stays claimable when the creator picks no expiry. */
export const DEFAULT_CLAIM_WINDOW_DAYS = 30
const NOTE_READ_TIMEOUT_MS = 20_000

function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const expiry = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms)
  })
  return Promise.race([work, expiry]).finally(() => clearTimeout(timer))
}

export type PaylinkStage = "building" | "proving" | "submitting"

const WALLET_ORIGINS: Record<string, string> = {
  mainnet: "https://wallet.zk.money",
  testnet: "https://staging.zk.money",
  sandbox: "http://localhost:5173",
}

/** The web wallet a link opens in; the CLI claims links from any origin. */
export function walletOrigin(network: string, env = process.env): string {
  return (
    env.ZKMONEY_WALLET_URL?.replace(/\/$/, "") ?? WALLET_ORIGINS[network] ?? WALLET_ORIGINS.mainnet!
  )
}

export const linkUrl = (network: string, fragment: string) =>
  `${walletOrigin(network)}/link#${fragment}`

/** A pasted link, from any host, or a bare fragment. */
export function parseLink(text: string): { fragment: string; params: PaylinkParams } {
  const t = text.trim()
  const fragment = t.includes("#") ? t.slice(t.indexOf("#") + 1) : t
  try {
    if (!fragment) throw new Error("empty")
    return { fragment, params: decodePaylinkInline(fragment) }
  } catch {
    fail(`"${text}" is not a payment link`, "paste the whole link, or the part after #")
  }
}

export const isEmailLink = (params: PaylinkParams) =>
  params.paylinkType === DEFAULT_CONTRACTS.paylinkEmail

export async function latestChainSeconds(rt: Pick<Runtime, "node">): Promise<number> {
  const header = (await rt.node.getBlockData("latest"))?.header
  if (!header) fail("the node has no block yet")
  return Number(header.globalVariables.timestamp)
}

async function paylinkService(rt: Runtime): Promise<PaylinkService> {
  const { account } = await rt.account()
  return new PaylinkService(
    rt.wallet,
    account,
    await rt.tokenService(),
    rt.contractService,
    undefined,
    await requireTeeSigner(rt),
  )
}

/** Status reads need no account and no signer; placeholders keep them runnable without the keys. */
function statusService(rt: Runtime): PaylinkService {
  const sender = { getAddress: () => AztecAddress.ZERO } as unknown as ObsidionAccount
  return new PaylinkService(rt.wallet, sender, {} as TokenService, rt.contractService)
}

/** Predicate for this account's create row of one link: the secret and flavor name the escrow. */
function createRowMatcher(secret: string, account?: string) {
  return (tx: unknown): boolean => {
    const row = tx as Partial<PaylinkTransaction>
    return (
      row.emailPaymentAction === PaylinkActionEnum.PAY &&
      row.payToEmailSecret === secret &&
      row.flavor === "direct" &&
      (account === undefined || row.obsidionAccountAddress === account)
    )
  }
}

export async function creatorRowFor(
  rt: Pick<Runtime, "storage">,
  params: PaylinkParams,
): Promise<PaylinkTransaction | undefined> {
  const rows = await TransactionStorage.get(rt.storage).getTransactions()
  return rows.find(createRowMatcher(params.secret.toString())) as PaylinkTransaction | undefined
}

/**
 * The activity row of a paylink leg: pending before the proof, its hash at the submit boundary,
 * then settled here as soon as the sponsored call resolves.
 */
async function startRow(
  rt: Runtime,
  svc: PaylinkService,
  kind: "paylink-create" | "paylink-claim" | "paylink-refund",
  action: PaylinkActionEnum.PAY | PaylinkActionEnum.CLAIM | PaylinkActionEnum.CLAIM_BACK,
  amountHuman: number | undefined,
  opts: { memo?: string; operationId: string },
): Promise<string> {
  TransactionStorage.get(rt.storage)
  const lifecycle = TxLifecycleService.getInstance()
  const queueId = await lifecycle.startTrackingTx(action, 240_000, svc)
  const token = await (await rt.tokenService()).fetchTokenInformation()
  const { account } = await rt.account()
  await lifecycle.recordPreSubmitPaylinkRow(queueId, opts.operationId, {
    action,
    flavor: "direct",
    kind,
    ...(opts.memo !== undefined ? { memo: opts.memo } : {}),
    token: {
      symbol: token.symbol,
      name: token.name,
      address: token.address,
      logo: "",
      amount: amountHuman ?? 0,
      decimals: token.decimals,
      price: 1,
      hasUnknownAmount: amountHuman === undefined,
    },
    obsidionAccountAddress: account.getAddress().toString(),
    tokenAddress: token.address,
  })
  return queueId
}

const saveRowTxHash = (queueId: string) => (txHash: string) =>
  TxLifecycleService.getInstance().patchTxHashForQueue(queueId, txHash)

async function finishRow(
  queueId: string,
  txHash: string,
  fields?: Parameters<TxLifecycleService["patchPaylinkSynthRow"]>[1],
): Promise<void> {
  const lifecycle = TxLifecycleService.getInstance()
  await lifecycle.patchTxHashForQueue(queueId, txHash)
  if (fields) await lifecycle.patchPaylinkSynthRow(queueId, fields)
  lifecycle.completeTransaction(queueId, QueueStatus.SUCCESS, txHash)
}

/** Past the submit boundary the row stays pending for the chain; before it, the row fails. */
async function rowFailure(
  rt: Runtime,
  queueId: string,
  error: unknown,
  submission: Pick<SubmissionTracker, "survived">,
): Promise<{ inFlight: string } | undefined> {
  const inFlight = await submission.survived(rt.node)
  if (inFlight) return { inFlight }
  TxLifecycleService.getInstance().completeTransaction(
    queueId,
    QueueStatus.FAILED,
    undefined,
    error instanceof Error ? error.message : String(error),
  )
  return undefined
}

async function markCreateRow(
  rt: Runtime,
  secret: string,
  update: (row: PaylinkTransaction) => void,
): Promise<void> {
  const account = (await rt.account()).account.getAddress().toString()
  await TransactionStorage.get(rt.storage)
    .updateTransaction(createRowMatcher(secret, account), (tx) => update(tx as PaylinkTransaction))
    .catch(() => {})
}

export interface PaylinkRecord {
  fragment: string
  url: string
  amountAtomic: string
  decimals: number
  symbol: string
  memo?: string
  /** The funding tx; absent when the deposit went out without its receipt. */
  txHash?: string
  untilClaimable: number
  /** Whether the link carries a sponsored transaction, so an account without a tag can claim it. */
  voucher?: boolean
  outcome: "mined" | "submitted"
}

/**
 * Whether a link made now can carry a voucher: the deployment offers the voucher rail and this
 * account's sponsored uses cover both the create and the gift it spends. Never throws; a link
 * without a voucher is still a link.
 */
export async function voucherAvailable(rt: Runtime): Promise<boolean> {
  try {
    await claimSponsorRail(rt, RAIL_VOUCHER)
    const { sponsor } = await claimSponsorRail(rt, RAIL_REGISTERED)
    const { account } = await rt.account()
    const uses = await claimFpcSubscriptionUses(
      rt.wallet,
      sponsor.fpcAddress,
      sponsor.fpcArtifact,
      account.getAddress(),
      sponsor.railId,
    )
    return uses >= 2
  } catch {
    return false
  }
}

export const newPaylinkId = () =>
  `link-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`

export async function createPaylink(
  rt: Runtime,
  input: { amount: string; memo?: string; expiryDays?: number; key?: string; voucher?: boolean },
  onStage: (stage: PaylinkStage) => void,
): Promise<{ id: string; record: PaylinkRecord; replayed: boolean }> {
  const id = input.key ?? newPaylinkId()
  const records = new Records(rt.storage)
  await refuseInterrupted(records, PAYLINK_KIND, id, "check `zkmoney txs`, then use a new key")
  onStage("building")
  await activateNetwork(rt)
  const tokenService = await rt.tokenService()
  const token = await tokenService.fetchTokenInformation()
  const amount = parseSendAmount(input.amount, token.decimals)
  const memo = input.memo?.trim() || undefined
  const expiryDays = input.expiryDays ?? DEFAULT_CLAIM_WINDOW_DAYS
  if (!Number.isInteger(expiryDays) || expiryDays < 1) fail("the expiry is whole days, at least 1")
  const windowSeconds = BigInt(expiryDays) * SECONDS_IN_A_DAY
  if (windowSeconds <= PAYLINK_GRACE_PERIOD_SECONDS)
    fail(`the claim window must outlast the ${PAYLINK_GRACE_PERIOD_SECONDS}s grace period`)
  const { unlocked, account } = await rt.account()
  const { result, replayed } = await records.once<PaylinkRecord>(
    PAYLINK_KIND,
    id,
    { amount: amount.atomic.toString(), memo, expiryDays, voucher: input.voucher !== false },
    async () => {
      const balance = await tokenService.getBalance()
      if (balance < amount.atomic) fail("the balance does not cover the link")
      const svc = await paylinkService(rt)
      const sponsor = await sponsorOrFail(rt, unlocked.file.identity?.tag)
      // A link matters more than the gift riding it: one the allowance cannot cover goes without.
      const voucherRail =
        input.voucher !== false && (await voucherAvailable(rt))
          ? (await claimSponsorRail(rt, RAIL_VOUCHER).catch(() => undefined))?.sponsor
          : undefined
      const chainNow = BigInt(await latestChainSeconds(rt))
      const windows = paylinkWindows(chainNow, windowSeconds, PAYLINK_GRACE_PERIOD_SECONDS)
      const operationId = nextOperationId("paylink-create")
      const queueId = await startRow(
        rt,
        svc,
        "paylink-create",
        PaylinkActionEnum.PAY,
        Number(amount.text),
        {
          memo,
          operationId,
        },
      )
      const rowFields = (p: { secret: Fr; fallbackSecret: Fr }, url: string) => ({
        payToEmailSecret: p.secret.toString(),
        fallbackSecret: p.fallbackSecret.toString(),
        fromClaimable: Number(windows.fromClaimable),
        untilClaimable: Number(windows.untilClaimable),
        refundableUntil: Number(windows.refundableUntil),
        paylink: url,
      })
      const base = {
        voucher: voucherRail !== undefined,
        amountAtomic: amount.atomic.toString(),
        decimals: token.decimals,
        symbol: token.symbol,
        memo,
        untilClaimable: Number(windows.untilClaimable),
      }
      let link: { fragment: string; url: string } | undefined
      const submission = trackSubmission(operationId, saveRowTxHash(queueId))
      try {
        onStage("proving")
        const params = await svc.createSponsoredPaylink(
          {
            amount: amount.atomic,
            token: tokenService.tokenAddress,
            window: windows,
            memo,
            senderTag: unlocked.file.identity?.tag,
            masterSecret: unlocked.masterSecret,
            ...(voucherRail ? { voucher: { railId: voucherRail.railId } } : {}),
          },
          sponsor,
          {
            operationId,
            // The link exists before the deposit proves: the pending row carries it from here.
            onPrepared: async (prepared) => {
              const fragment = encodePaylinkInline(prepared)
              link = { fragment, url: linkUrl(rt.network, fragment) }
              await TxLifecycleService.getInstance().patchPaylinkSynthRow(
                queueId,
                rowFields(prepared, link.url),
              )
            },
          },
        )
        if (sponsor.subscribe) noteSubscribed(account, sponsor)
        onStage("submitting")
        const fragment = encodePaylinkInline(params)
        link = { fragment, url: linkUrl(rt.network, fragment) }
        await finishRow(queueId, params.txHash, rowFields(params, link.url))
        return { ...base, ...link, txHash: params.txHash, outcome: "mined" }
      } catch (err) {
        const failure = await rowFailure(rt, queueId, err, submission)
        if (failure && link)
          return { ...base, ...link, txHash: failure.inFlight, outcome: "submitted" }
        throw err
      } finally {
        await submission.stop()
      }
    },
  )
  return { id, record: result, replayed }
}

/** A link by its record id, else as pasted. */
export async function linkFor(
  rt: Pick<Runtime, "storage">,
  text: string,
): Promise<{ fragment: string; params: PaylinkParams; record?: PaylinkRecord }> {
  const known = await new Records(rt.storage).get<PaylinkRecord>(PAYLINK_KIND, text.trim())
  if (known?.result) return { ...parseLink(known.result.fragment), record: known.result }
  if (known) fail(`link "${text}" was never created`, known.error ?? "the process was interrupted")
  return parseLink(text)
}

export type CreatorAction = "cancel" | "reclaim"

/**
 * Which recovery the creator's row offers: cancel while a refund can still land before the window
 * shuts, reclaim once the link expired, nothing while only the recipient can move the funds.
 */
export function creatorAction(
  row: PaylinkTransaction,
  nowSec: number,
  status: PaylinkStatusKind,
): CreatorAction | undefined {
  if (status !== "awaitingClaim" && status !== "expired") return undefined
  if (!paylinkRefundEligibility(row, nowSec).eligible) return undefined
  if (isPaylinkInRefundWindow(row, nowSec))
    return nowSec + Number(PAYLINK_CANCEL_MARGIN_SECONDS) < row.refundableUntil!
      ? "cancel"
      : undefined
  return "reclaim"
}

export interface PaylinkView {
  fragment: string
  url: string
  /** The nullifier is spent: claimed, or refunded by the creator. */
  spent: boolean
  note?: PaylinkNoteView
  memo?: string
  fundingTxHash?: string
  chainNow: number
  /** This account's create row and what it can still do. */
  creator?: { row: PaylinkTransaction; status: PaylinkStatusKind; action?: CreatorAction }
}

export async function viewPaylink(rt: Runtime, text: string): Promise<PaylinkView> {
  const { fragment, params, record } = await linkFor(rt, text)
  if (isEmailLink(params)) fail("this is an email-locked link; the CLI handles direct links only")
  const svc = statusService(rt)
  const [spent, chainNow] = await Promise.all([
    svc.isPaylinkClaimed(params),
    latestChainSeconds(rt),
  ])
  const view: PaylinkView = {
    fragment,
    url: record?.url ?? linkUrl(rt.network, fragment),
    spent,
    chainNow,
    fundingTxHash: record?.txHash,
  }
  if (!spent) {
    try {
      // The note read simulates against a PXE that trails the tip; bounded so it cannot hang the status.
      const resolved = await withTimeout(svc.resolveLink(params), NOTE_READ_TIMEOUT_MS)
      view.note = resolved.note
      view.memo = resolved.memo
      view.fundingTxHash ??= resolved.txHash
    } catch {
      // Unreadable is not spent: the nullifier said unclaimed, only the amount is missing.
    }
  }
  const row = await creatorRowFor(rt, params)
  if (row) {
    await new PaylinkClaimReconciler({
      checkSpent: checkSpentViaPaylinkService(svc),
      storage: TransactionStorage.get(rt.storage),
    }).reconcileTxHash(row.txHash)
    const current = (await creatorRowFor(rt, params)) ?? row
    const status = paylinkStatusFor(current, chainNow)
    view.creator = { row: current, status, action: creatorAction(current, chainNow, status) }
  }
  return view
}

/** The link's own voucher as a sponsor, when its escrow still holds one; undefined when spent or the rail is unknown. */
async function linkVoucher(
  rt: Runtime,
  params: PaylinkParams,
): Promise<ClaimSponsorContext | undefined> {
  let sponsor: ClaimSponsorContext
  try {
    sponsor = (await claimSponsorRail(rt, RAIL_VOUCHER)).sponsor
  } catch (err) {
    if (err instanceof UnknownRailError) return undefined
    throw err
  }
  const uses = await paylinkVoucherUses(
    { wallet: rt.wallet, contractService: rt.contractService, sponsor },
    params,
  )
  return uses > 0 ? sponsor : undefined
}

/** Who pays for the claim: this account's own rail, else the voucher the creator gifted the link. */
async function claimRail(
  rt: Runtime,
  params: PaylinkParams,
  tag: string | undefined,
): Promise<{ sponsor: ClaimSponsorContext; voucher?: ClaimSponsorContext }> {
  try {
    return { sponsor: await sponsorOrFail(rt, tag) }
  } catch (err) {
    const voucher = await linkVoucher(rt, params).catch(() => undefined)
    if (!voucher) throw err
    return { sponsor: voucher, voucher }
  }
}

export interface ClaimResult {
  txHash: string
  amountAtomic?: string
  outcome: "mined" | "submitted"
}

export async function claimPaylink(
  rt: Runtime,
  text: string,
  onStage: (stage: PaylinkStage) => void,
): Promise<ClaimResult> {
  onStage("building")
  await activateNetwork(rt)
  const { params } = parseLink(text)
  if (isEmailLink(params)) fail("this is an email-locked link; the CLI claims direct links only")
  const { unlocked, account } = await rt.account()
  const svc = await paylinkService(rt)
  if (await svc.isPaylinkClaimed(params)) fail("this link was already claimed or cancelled")
  const { sponsor, voucher } = await claimRail(rt, params, unlocked.file.identity?.tag)
  const token = await (await rt.tokenService()).fetchTokenInformation()
  const note = await readPaylinkNote(svc, params)
  const chainNow = await latestChainSeconds(rt)
  if (note && chainNow < note.claimableFrom)
    fail(`the link opens in ${note.claimableFrom - chainNow}s`, "try again in a moment")
  if (note && chainNow > note.claimableUntil) fail("this link has expired")
  const operationId = nextOperationId("paylink-claim")
  const queueId = await startRow(
    rt,
    svc,
    "paylink-claim",
    PaylinkActionEnum.CLAIM,
    note && Number(formatUnits(note.amount, token.decimals)),
    { operationId },
  )
  const submission = trackSubmission(operationId, saveRowTxHash(queueId))
  try {
    onStage("proving")
    const txHash = await svc.claimSponsoredPaylink(params, sponsor, {
      operationId,
      ...(voucher ? { voucher: { railId: voucher.railId } } : {}),
    })
    if (sponsor.subscribe) noteSubscribed(account, sponsor)
    onStage("submitting")
    await finishRow(queueId, txHash)
    await markCreateRow(rt, params.secret.toString(), (row) => {
      row.isClaimed = true
      row.paylink = undefined
    })
    return { txHash, amountAtomic: note?.amount.toString(), outcome: "mined" }
  } catch (err) {
    const failure = await rowFailure(rt, queueId, err, submission)
    if (failure)
      return {
        txHash: failure.inFlight,
        amountAtomic: note?.amount.toString(),
        outcome: "submitted",
      }
    throw err
  } finally {
    await submission.stop()
  }
}

export interface CancelResult {
  txHash: string
  kind: CreatorAction
  outcome: "mined" | "submitted"
}

/**
 * Take an unclaimed link back: a cancel inside the refund window, a reclaim once it expired. The
 * escrow decides the branch from chain time; the row's window only says whether to try.
 */
export async function cancelPaylink(
  rt: Runtime,
  text: string,
  onStage: (stage: PaylinkStage) => void,
): Promise<CancelResult> {
  onStage("building")
  await activateNetwork(rt)
  const { params } = await linkFor(rt, text)
  if (isEmailLink(params)) fail("this is an email-locked link; the CLI handles direct links only")
  const { unlocked, account } = await rt.account()
  const [row, chainNow] = await Promise.all([creatorRowFor(rt, params), latestChainSeconds(rt)])
  if (!row) fail("this account did not create that link", "only the creator can cancel it")
  const status = paylinkStatusFor(row, chainNow)
  const action = creatorAction(row, chainNow, status)
  if (!action) {
    if (status === "claimed" || status === "refunded") fail(`this link was already ${status}`)
    if (!paylinkRefundEligibility(row, chainNow).eligible && status === "awaitingClaim")
      fail(
        "the refund window has closed; only the recipient can move the funds until the link expires",
      )
    throw new PaylinkWindowClosedError()
  }
  const svc = await paylinkService(rt)
  const sponsor = await sponsorOrFail(rt, unlocked.file.identity?.tag)
  const operationId = nextOperationId("paylink-refund")
  const queueId = await startRow(
    rt,
    svc,
    "paylink-refund",
    PaylinkActionEnum.CLAIM_BACK,
    row.token?.amount,
    {
      operationId,
    },
  )
  const secret = params.secret.toString()
  // The creator row learns of the refund at submit: after a restart the reconciler would otherwise
  // read the spent note as a recipient's claim.
  const submission = trackSubmission(operationId, async (txHash) => {
    await saveRowTxHash(queueId)(txHash)
    await markCreateRow(rt, secret, (r) => {
      r.refundTxHash = txHash
    })
  })
  try {
    onStage("proving")
    const txHash = await svc.refundSponsoredPaylink(params, sponsor, { operationId })
    if (sponsor.subscribe) noteSubscribed(account, sponsor)
    onStage("submitting")
    await finishRow(queueId, txHash)
    await markCreateRow(rt, secret, (r) => {
      r.isRefunded = true
      r.paylink = undefined
      r.refundTxHash = txHash
    })
    return { txHash, kind: action, outcome: "mined" }
  } catch (err) {
    const failure = await rowFailure(rt, queueId, err, submission)
    if (failure) return { txHash: failure.inFlight, kind: action, outcome: "submitted" }
    throw err
  } finally {
    await submission.stop()
  }
}
