/**
 * A private L2 payment, sponsored by the deployment's ClaimFPC on the registered rail. The history
 * row is written before the proof and advanced in place, so a process killed mid-flight leaves a
 * pending row for the chain sync to settle; the payment record keeps the outcome under its id.
 */
import { AztecAddress } from "@aztec/stdlib/aztec-address"
import { TxHash, TxStatus } from "@aztec/stdlib/tx"
import { QueueStatus } from "@obsidion/core/constants"
import {
  ContactStorage,
  TransactionStorage,
  getActiveNetworkId,
  isRevertedInclusion,
  normalizeAmountInput,
  normalizeTag,
  parseEscrowAmount,
  resolveTagViaRegistry,
  setActiveNetworkId,
  trackSubmission,
  validateAddress,
  validateAmount,
  type Contact,
  type Transaction,
} from "../frontCore.ts"
import { nextOperationId, type ClaimSponsorContext } from "@obsidion/sdk"
import { amount as formatAmount, fail } from "../output.ts"
import type { Runtime } from "./boot.ts"
import { Records, type OperationRecord } from "./records.ts"
import {
  RAIL_REGISTERED,
  RegistrationPendingError,
  claimSponsorContext,
  noteSubscribed,
} from "./sponsor.ts"
import { registryOpts } from "./sync.ts"

export const PAYMENT_KIND = "payment"

/**
 * Stamp every row this process writes with its network, the way the sync does, so the sync's
 * reorg pass settles them later. Same id format as `openSync`.
 */
export async function activateNetwork(rt: Pick<Runtime, "network" | "node">): Promise<void> {
  if (getActiveNetworkId()) return
  setActiveNetworkId(`${rt.network}:${(await rt.node.getNodeInfo()).rollupVersion}`)
}

export type SendStage = "resolving" | "proving" | "submitting"

export interface ParsedAmount {
  atomic: bigint
  /** The amount as typed, separators folded to a dot. */
  text: string
}

/** Dollars with at most two decimals, positive, in the token's base units. */
export function parseSendAmount(input: string, decimals: number): ParsedAmount {
  const text = normalizeAmountInput(input.trim())
  if (!validateAmount(text))
    fail(
      `"${input}" is not an amount`,
      "use a positive number with at most two decimals, like 12.50",
    )
  return { atomic: parseEscrowAmount(text, decimals).atomic, text }
}

/** The L2 balance is one asset; a name for another is refused before the chain is asked. */
export function assertSendAsset(network: string, asset: string | undefined, symbol: string): void {
  if (!asset || asset.toUpperCase() === symbol.toUpperCase()) return
  fail(
    `cannot send ${asset}: the L2 balance is ${symbol}`,
    network === "mainnet"
      ? "on mainnet the only L2 asset is DAI; USDC and USDT are swapped to DAI on deposit and back on withdrawal"
      : undefined,
  )
}

export interface Recipient {
  l2Address: string
  /** `@tag`, the contact's name, or the address itself. */
  label: string
  tag?: string
  contact?: string
}

const isL2Address = (text: string) => /^0x[0-9a-fA-F]{64}$/.test(text) && validateAddress(text)
const isL2Contact = (c: Contact) => (c.addressKind ?? "aztec-l2") === "aztec-l2"

/** The saved L2 contact `to` names, by name or by tag. */
export function matchContact(contacts: Contact[], to: string): Contact | undefined {
  const needle = to.trim().toLowerCase()
  const tag = normalizeTag(to)
  return contacts.find(
    (c) => isL2Contact(c) && (c.name.toLowerCase() === needle || (tag !== null && c.tag === tag)),
  )
}

/**
 * Where a payment goes. A tag, saved or not, is resolved on the registry at send time so a
 * re-registered name never pays a stale address; a contact without a tag pays its saved address.
 */
export async function resolveRecipient(rt: Runtime, to: string): Promise<Recipient> {
  const text = to.trim()
  if (isL2Address(text)) return { l2Address: text, label: text }
  const contact = matchContact(await ContactStorage.get(rt.storage).getEntries(), text)
  const tag = contact?.tag ?? normalizeTag(text)
  if (!tag) {
    if (contact) return { l2Address: contact.address, label: contact.name, contact: contact.name }
    fail(
      `"${to}" is not a saved contact, a tag or an L2 address`,
      "a tag is letters, digits, _ and -; save an address with `zkmoney contacts add`",
    )
  }
  const resolved = await resolveTagViaRegistry(tag, registryOpts(rt))
  if (resolved.status === "notFound") fail(`@${tag} is not registered`)
  if (resolved.status === "staleRollup") fail(`@${tag} has not upgraded to the current network yet`)
  return {
    l2Address: resolved.l2Address,
    label: contact ? `${contact.name} (@${tag})` : `@${tag}`,
    tag,
    contact: contact?.name,
  }
}

/** The registered rail's sponsor, or why this account cannot ride it yet. */
export async function sponsorOrFail(
  rt: Runtime,
  tag: string | undefined,
): Promise<ClaimSponsorContext> {
  try {
    return await claimSponsorContext(rt, RAIL_REGISTERED, tag)
  } catch (err) {
    if (!(err instanceof RegistrationPendingError)) throw err
    if (!tag && err.state.pending === "message")
      fail(
        "this account has no registered tag, so nothing sponsors its transactions",
        "register one with `zkmoney register <tag>`",
      )
    fail(err.message, "try again in a few minutes")
  }
}

export interface PaymentRecord {
  operationId: string
  to: string
  label: string
  tag?: string
  amountAtomic: string
  symbol: string
  decimals: number
  memo?: string
  txHash?: string
  blockNumber?: number
  /** `submitted`: sent, outcome unknown when the process last looked; `payments get` asks the node. */
  outcome: "mined" | "submitted"
}

export const newPaymentId = () =>
  `pay-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`

/**
 * A key whose earlier attempt neither finished nor failed was cut off mid-flight, so what it sent
 * is unknown; it is not retried blind.
 */
export async function refuseInterrupted(
  records: Records,
  kind: string,
  key: string,
  hint: string,
): Promise<void> {
  const known = await records.get(kind, key)
  if (known && known.result === undefined && known.error === undefined)
    fail(`"${key}" was interrupted before it finished`, hint)
}

export interface SendInput {
  amount: string
  to: string
  asset?: string
  memo?: string
  key?: string
}

export async function sendPayment(
  rt: Runtime,
  input: SendInput,
  onStage: (stage: SendStage) => void,
): Promise<{ id: string; record: PaymentRecord; replayed: boolean }> {
  const id = input.key ?? newPaymentId()
  const records = new Records(rt.storage)
  await refuseInterrupted(
    records,
    PAYMENT_KIND,
    id,
    "check `zkmoney txs` for the earlier send, then use a new key",
  )
  onStage("resolving")
  await activateNetwork(rt)
  const tokenService = await rt.tokenService()
  const token = await tokenService.fetchTokenInformation()
  assertSendAsset(rt.network, input.asset, token.symbol)
  const amount = parseSendAmount(input.amount, token.decimals)
  const recipient = await resolveRecipient(rt, input.to)
  const { unlocked, account } = await rt.account()
  if (recipient.l2Address.toLowerCase() === account.getAddress().toString().toLowerCase())
    fail("that is this wallet's own address")
  const memo = input.memo?.trim() || undefined
  const base: Omit<PaymentRecord, "operationId" | "outcome"> = {
    to: recipient.l2Address,
    label: recipient.label,
    tag: recipient.tag,
    amountAtomic: amount.atomic.toString(),
    symbol: token.symbol,
    decimals: token.decimals,
    memo,
  }
  const { result, replayed } = await records.once<PaymentRecord>(
    PAYMENT_KIND,
    id,
    { to: recipient.l2Address, amount: base.amountAtomic, memo },
    async () => {
      const balance = await tokenService.getBalance()
      if (balance < amount.atomic)
        fail(
          `the balance is ${formatAmount(
            balance,
            token.decimals,
            token.symbol,
          )}, below ${formatAmount(amount.atomic, token.decimals, token.symbol)}`,
        )
      const sponsor = await sponsorOrFail(rt, unlocked.file.identity?.tag)
      const resolveSpendMetadata = await account.makeSpendMetadataResolver()
      const operationId = nextOperationId("send")
      const store = TransactionStorage.get(rt.storage)
      const patch = (update: (tx: Transaction) => void) =>
        store.updateTransaction((tx) => tx.queueId === operationId, update)
      await store.addTokenTransaction(
        "send",
        {
          address: token.address,
          name: token.name,
          symbol: token.symbol,
          decimals: token.decimals,
          logo: "",
          price: 1,
          amount: Number(amount.text),
        },
        "pending",
        undefined,
        recipient.l2Address,
        operationId,
        undefined,
        memo,
        recipient.tag,
      )
      // A missing row saved nothing, so it must not read as saved.
      const submission = trackSubmission(operationId, async (txHash) => {
        const saved = await patch((tx) => {
          tx.txHash = txHash
          tx.detailedStatus = QueueStatus.MINING
        })
        if (!saved) throw new Error("send row missing")
      })
      onStage("proving")
      let sent: { txHash: string; blockNumber: number }
      try {
        sent = await tokenService.sendTokenSponsored(
          AztecAddress.fromStringUnsafe(recipient.l2Address),
          amount.atomic.toString(),
          sponsor,
          {
            userAccount: account,
            useRawAmount: true,
            resolveSpendMetadata,
            operationId,
            senderTag: unlocked.file.identity?.tag,
            recipientTag: recipient.tag,
            memo,
          },
        )
      } catch (err) {
        // Past the submit boundary the row stays at MINING for the chain to settle.
        const inFlight = await submission.survived(rt.node)
        if (inFlight) return { ...base, operationId, txHash: inFlight, outcome: "submitted" }
        await patch((tx) => {
          tx.status = "failed"
          tx.detailedStatus = QueueStatus.FAILED
          tx.error = err instanceof Error ? err.message : String(err)
        }).catch(() => {})
        throw err
      } finally {
        await submission.stop()
      }
      if (sponsor.subscribe) noteSubscribed(account, sponsor)
      onStage("submitting")
      await patch((tx) => {
        tx.status = "success"
        tx.txHash = sent.txHash
        tx.detailedStatus = QueueStatus.SUCCESS
      }).catch(() => {})
      return {
        ...base,
        operationId,
        txHash: sent.txHash,
        blockNumber: sent.blockNumber,
        outcome: "mined",
      }
    },
  )
  return { id, record: result, replayed }
}

export type TxOutcome = "pending" | "mined" | "failed" | "dropped"

/** What a receipt says: one of the four words a person needs. */
export function receiptOutcome(receipt: {
  status: TxStatus
  executionResult?: Parameters<typeof isRevertedInclusion>[0]["executionResult"]
}): TxOutcome {
  if (receipt.status === TxStatus.DROPPED) return "dropped"
  if (receipt.status === TxStatus.PENDING) return "pending"
  return isRevertedInclusion(receipt) ? "failed" : "mined"
}

/** The chain's word on a transaction; undefined while the node cannot be asked. */
export async function txOutcome(
  rt: Pick<Runtime, "node">,
  txHash: string,
): Promise<TxOutcome | undefined> {
  try {
    return receiptOutcome(await rt.node.getTxReceipt(TxHash.fromString(txHash)))
  } catch {
    return undefined
  }
}

export type PaymentStatus = TxOutcome | "interrupted"

/**
 * A payment's status: the chain's word when it has a hash, else what the record says happened
 * before one existed.
 */
export async function paymentStatus(
  rt: Pick<Runtime, "node"> | undefined,
  record: OperationRecord<PaymentRecord>,
): Promise<{ status: PaymentStatus; detail?: string }> {
  const txHash = record.result?.txHash
  if (!txHash) {
    return record.error
      ? { status: "failed", detail: record.error }
      : { status: "interrupted", detail: "the process ended before the send reached the node" }
  }
  const outcome = rt ? await txOutcome(rt, txHash) : undefined
  if (outcome) return { status: outcome }
  return record.result?.outcome === "mined" ? { status: "mined" } : { status: "pending" }
}
