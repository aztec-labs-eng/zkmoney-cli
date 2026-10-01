/**
 * What a deposit address is quoted with and how a deposit record reads on the terminal: the tokens a
 * SIPA on this network accepts, the request window a depositor should stay inside, one phase word per
 * record. Pure, so every deposits command prints the same words for the same state.
 */
import { formatUnits, parseUnits, type Address } from "viem"
import { MAINNET_USDC, MAINNET_USDT } from "@oxide/l1-contracts/deposit_tokens.js"
import { DEFAULT_DECIMALS, Network } from "@obsidion/core/constants"
import { isUnfundedSipaDeposit, type SIPADepositRecord, type SipaFundingToken } from "../frontCore.ts"
import { amount } from "../output.ts"

/**
 * Every L1 token a SIPA on `network` may be funded with, the manifest token first. Mainnet sweeps
 * swap USDC and USDT into DAI; elsewhere only the portal's own token is accepted.
 */
export function sipaFundingTokens(
  network: Network,
  manifest: SipaFundingToken,
): [SipaFundingToken, ...SipaFundingToken[]] {
  if (network !== Network.MAINNET) return [manifest]
  return [
    manifest,
    { address: MAINNET_USDC.toString() as Address, symbol: "USDC", decimals: 6 },
    { address: MAINNET_USDT.toString() as Address, symbol: "USDT", decimals: 6 },
  ]
}

/** The accepted token whose symbol is `symbol`, case-insensitively. */
export function fundingTokenNamed(
  tokens: readonly SipaFundingToken[],
  symbol: string,
): SipaFundingToken | undefined {
  const needle = symbol.toUpperCase()
  return tokens.find((t) => t.symbol.toUpperCase() === needle)
}

/** An amount quoted in one dollar stable, in another's units (1:1, only the decimals differ). */
export function rescale(atomic: bigint, fromDecimals: number, toDecimals: number): bigint {
  return parseUnits(formatUnits(atomic, fromDecimals), toDecimals)
}

/**
 * Why a request of `amountAtomic` would not be swept, or undefined when it would. At or below the
 * fee nothing is left to credit; above the cap the portal refuses what it would take in. `fee` is in
 * the requested token's units; `capAtomic` in the manifest token's.
 */
export function requestWindowError(
  amountAtomic: bigint,
  fee: bigint,
  capAtomic: bigint,
  decimals: number,
  symbol: string,
): string | undefined {
  if (amountAtomic <= fee)
    return `the amount must exceed the deposit fee (${formatUnits(fee, decimals)} ${symbol})`
  if (amountAtomic - fee > rescale(capAtomic, DEFAULT_DECIMALS, decimals))
    return "the amount is over the network's maximum per deposit"
  return undefined
}

export type DepositPhaseLabel =
  | "awaiting"
  | "funded"
  | "sweeping"
  | "crediting"
  | "credited"
  | "needs recovery"
  | "recovered"
  | "failed"

/**
 * One word for where a deposit stands. `liveBalance` is the address's current L1 holding when it was
 * read: funds the store has not seen yet still count as funded.
 */
export function depositPhaseLabel(
  record: SIPADepositRecord,
  liveBalance?: bigint,
): DepositPhaseLabel {
  switch (record.phase) {
    case "claimed":
      return "credited"
    case "failed":
      return "failed"
    case "recovered":
      return "recovered"
    case "recoverable":
      return "needs recovery"
    case "pendingClaim":
      return "crediting"
    case "sweeping":
      return "sweeping"
    default:
      if (record.sweepTxHash || record.inboxIndex) return "sweeping"
      if ((liveBalance ?? 0n) > 0n) return "funded"
      return isUnfundedSipaDeposit(record) ? "awaiting" : "funded"
  }
}

/** Multiplies a balance of `sent` into the fee token's base units, as the sweep's window check does. */
export function feeScale(feeToken: SipaFundingToken, sent: SipaFundingToken): bigint {
  return 10n ** BigInt(Math.max(feeToken.decimals - sent.decimals, 0))
}

/** The record's amount in its token's units: the net once swept, the gross before, nothing while unfunded. */
export function recordAmount(
  record: SIPADepositRecord,
  fallbackDecimals: number,
): string | undefined {
  const decimals = record.tokenDecimals ?? fallbackDecimals
  try {
    const atomic = record.netAmount ? BigInt(record.netAmount) : parseUnits(record.amount, decimals)
    return atomic > 0n ? amount(atomic, decimals, record.tokenSymbol) : undefined
  } catch {
    return `${record.amount} ${record.tokenSymbol}`
  }
}
