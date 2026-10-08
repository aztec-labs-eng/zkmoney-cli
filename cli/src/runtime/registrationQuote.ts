/**
 * The runtime-free half of registration: which tokens a deposit may arrive in, what to ask the
 * user to send, and the lines the terminal shows. Nothing here reads a chain, so it is testable
 * without a wallet.
 */
import { REGISTRATION_ASK_DEPOSIT_TOTAL, registrationFloor } from "@obsidion/core/constants"
import type {
  NameClaimResponse,
  NameHold,
  RegistrationKind,
  RegistrationSchedule,
} from "@obsidion/core/types"
import {
  type PendingRegistrationPhase,
  type PendingRegistrationRecord,
  type SipaFundingToken,
} from "../frontCore.ts"
import { amount, fields, shorten, when } from "../output.ts"
import { feeScale } from "./depositFacts.ts"

/** The sign response with its reservation hold optional, so a response without one still reads. */
export type SignedClaim = Omit<NameClaimResponse, "hold"> & { hold?: NameHold }

/** When the reservation hold ends, unix seconds; undefined when the response carried no hold. */
export function holdDeadline(claim: Pick<SignedClaim, "hold">): number | undefined {
  const raw = claim.hold?.deadline
  return raw !== undefined && /^\d+$/.test(raw) ? Number(raw) : undefined
}

/**
 * The schedule a claim signed, when it prices anything. A zero quote is a signer running without a
 * schedule, not a free registration, so it prices nothing and the chain's schedule applies.
 */
export function signedSchedule(
  terms: { fee?: string; minDeposit?: string } | null | undefined,
): RegistrationSchedule | undefined {
  if (terms?.fee === undefined || terms.minDeposit === undefined) return undefined
  const schedule = { fee: BigInt(terms.fee), min: BigInt(terms.minDeposit) }
  return schedule.fee === 0n && schedule.min === 0n ? undefined : schedule
}

/**
 * What the claim server quoted, kept beside the record. The record holds no bearer material and
 * the claim is never persisted, but the signed amounts price the floor and the hold says how long
 * the name is held.
 */
export interface RegistrationTerms {
  /** The registration's L1 account (the record key). */
  account: string
  tag: string
  /** The NameClaim's validity, unix seconds. */
  claimDeadline: number
  /** The reservation hold, unix seconds: the name frees for anyone past it. */
  holdDeadline?: number
  fee?: string
  minDeposit?: string
  reduced?: boolean
}

export function termsFromClaim(
  account: string,
  tag: string,
  claim: SignedClaim,
): RegistrationTerms {
  const hold = holdDeadline(claim)
  return {
    account,
    tag,
    claimDeadline: Number(claim.deadline),
    ...(hold !== undefined ? { holdDeadline: hold } : {}),
    ...(claim.terms
      ? {
          fee: claim.terms.fee,
          minDeposit: claim.terms.minDeposit,
          reduced: claim.terms.reduced === true,
        }
      : {}),
  }
}

/** `reduced` on the signed terms is the one flag that names the earned kind. */
export const registrationKind = (reduced: boolean | undefined): RegistrationKind =>
  reduced === true ? "earned_tag" : "standard"

/**
 * The schedule that prices a record: the signed one, else the chain's, and only while it names the
 * fee the address committed to. Another schedule cannot register that address.
 */
export function scheduleForRecord(
  record: Pick<PendingRegistrationRecord, "fee">,
  terms: RegistrationTerms | undefined,
  chain: RegistrationSchedule,
): RegistrationSchedule | undefined {
  const committed = record.fee !== undefined ? BigInt(record.fee) : undefined
  const names = (s: RegistrationSchedule | undefined) =>
    s !== undefined && (committed === undefined || s.fee === committed) ? s : undefined
  return names(signedSchedule(terms)) ?? names(chain)
}

export interface RegistrationQuote {
  kind: RegistrationKind
  /** What to ask for. The kind's ask, or the floor when a deployment's floor outgrew it. */
  total: bigint
  /** The least the chain accepts; absent until both the schedule and the portal's cut are known. */
  floor?: bigint
  fee?: bigint
  /** The ask sat under the floor, so the floor is asked for instead. */
  raised: boolean
}

export function registrationQuote(
  schedule: RegistrationSchedule | undefined,
  kind: RegistrationKind,
  fpcFundingCut: bigint | undefined,
): RegistrationQuote {
  const ask = REGISTRATION_ASK_DEPOSIT_TOTAL[kind]
  if (!schedule || fpcFundingCut === undefined) {
    return { kind, total: ask, fee: schedule?.fee, raised: false }
  }
  const floor = registrationFloor(schedule, fpcFundingCut)
  return { kind, total: floor > ask ? floor : ask, floor, fee: schedule.fee, raised: floor > ask }
}

export interface TokenBalance {
  token: SipaFundingToken
  balance: bigint
}

/** "3.00 USDC, 1.00 DAI" for what the address holds, or "nothing yet". */
export function fundingSummary(balances: readonly TokenBalance[]): string {
  const held = balances.filter((b) => b.balance > 0n)
  if (!held.length) return "nothing yet"
  return held.map((b) => amount(b.balance, b.token.decimals, b.token.symbol)).join(", ")
}

/** The largest balance in fee-token units: the figure the floor is checked against. */
export function fundedInFeeUnits(
  feeToken: SipaFundingToken,
  balances: readonly TokenBalance[],
): bigint {
  return balances.reduce((best, b) => {
    const scaled = b.balance * feeScale(feeToken, b.token)
    return scaled > best ? scaled : best
  }, 0n)
}

export function phaseLabel(phase: PendingRegistrationPhase): string {
  switch (phase) {
    case "awaiting_deposit":
      return "waiting for the deposit"
    case "funded":
      return "deposit seen, waiting for a relayer to sweep it"
    case "confirmed":
      return "registered"
    case "failed_taken":
      return "lost: the name went to another account"
    case "failed_terminal":
      return "abandoned"
  }
}

export function acceptedTokensLine(tokens: readonly SipaFundingToken[]): string {
  const symbols = tokens.map((t) => t.symbol)
  if (symbols.length === 1) return symbols[0]!
  const [fee, ...others] = symbols
  return `${symbols.join(", ")} (${others.join(" and ")} are swapped to ${fee})`
}

export interface DepositView {
  tag: string
  ensDomain: string
  sipaAddress: string
  /** Where the deposit goes: the L1 chain's name. */
  chainName: string
  l1Account: string
  feeToken: SipaFundingToken
  fundingTokens: readonly SipaFundingToken[]
  quote: RegistrationQuote
  /** ms */
  holdDeadline?: number
  /** ms; the NameClaim's own validity, shorter than the hold. */
  claimDeadline?: number
  broadcast: boolean
  full?: boolean
}

/** The deposit instructions, printed once the address exists. */
export function renderDeposit(view: DepositView): string {
  const { feeToken, quote } = view
  const send =
    quote.floor !== undefined && quote.floor < quote.total
      ? `${amount(quote.total, feeToken.decimals, feeToken.symbol)}  (at least ${amount(
          quote.floor,
          feeToken.decimals,
          feeToken.symbol,
        )})`
      : amount(quote.total, feeToken.decimals, feeToken.symbol)
  const lines = fields([
    ["Tag", `@${view.tag}  (${view.tag}.${view.ensDomain})`],
    ["Deposit address", view.sipaAddress],
    ["Chain", view.chainName],
    ["L1 account", shorten(view.l1Account, view.full)],
    ["Send", send],
    ["Accepted", acceptedTokensLine(view.fundingTokens)],
    [
      "Price",
      quote.fee !== undefined
        ? `${amount(quote.fee, feeToken.decimals, feeToken.symbol)} tag fee${
            quote.kind === "earned_tag" ? " (earned tag)" : ""
          }; the rest opens the balance`
        : undefined,
    ],
    ["Hold until", view.holdDeadline !== undefined ? when(view.holdDeadline) : undefined],
    ["Claim valid until", view.claimDeadline !== undefined ? when(view.claimDeadline) : undefined],
    ["Relayers", view.broadcast ? "notified" : "not notified yet"],
  ])
  const notes = [
    quote.raised
      ? "This deployment's floor is above the usual ask, so the floor is what to send."
      : undefined,
    "The address takes one deposit. Send the amount above in one transfer; a relayer sweeps it and the sweep registers the tag.",
    "`zkmoney register status` shows progress; `zkmoney register <tag> --wait` waits for it.",
  ].filter((n): n is string => n !== undefined)
  return `${lines}\n\n${notes.join("\n")}`
}

export interface StatusView {
  tag: string
  phase: PendingRegistrationPhase
  sipaAddress: string
  l1Account: string
  feeToken: SipaFundingToken
  balances: readonly TokenBalance[]
  floor?: bigint
  swept: boolean
  broadcast: boolean
  /** ms */
  holdDeadline?: number
  /** Whether the registry now names this account; null when it names another. */
  registered: boolean | null
  full?: boolean
}

export function renderStatus(view: StatusView): string {
  const held = fundedInFeeUnits(view.feeToken, view.balances)
  const received =
    view.swept && held === 0n
      ? "swept into the balance"
      : view.floor === undefined || held === 0n
        ? fundingSummary(view.balances)
        : `${fundingSummary(view.balances)}  (${
            held >= view.floor ? "covers the floor" : "below the floor"
          })`
  const registry =
    view.registered === null
      ? "names another account"
      : view.registered
        ? `registered as @${view.tag}`
        : "not yet"
  return fields([
    ["Tag", `@${view.tag}`],
    ["Phase", phaseLabel(view.phase)],
    ["Deposit address", shorten(view.sipaAddress, view.full)],
    ["L1 account", shorten(view.l1Account, view.full)],
    ["Received", received],
    ["Swept", view.swept ? "yes" : "no"],
    ["Relayers", view.broadcast ? "notified" : "not notified yet"],
    ["Hold until", view.holdDeadline !== undefined ? when(view.holdDeadline) : undefined],
    ["Registry", registry],
  ])
}
