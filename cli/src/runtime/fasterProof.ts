/**
 * A prover tip buys a burn an early proof: a prover proves its epoch up to the burn's checkpoint instead of waiting
 * for the epoch to end. The portal pays the tip in DAI, out of the burn.
 */
import { quoteWithdrawalProverTip } from "@obsidion/sdk"
import type { Address } from "viem"
import { WithdrawalSpeedupEstimator, type BurnLanding } from "../frontCore.ts"
import type { Runtime } from "./boot.ts"

/** A CLI burn proves natively and is mined within a minute or two; its checkpoint reaches L1 one slot later. */
const CLI_BURN_LANDING: BurnLanding = { expected: 90, earliest: 45, latest: 240 }

export interface FasterProof {
  proverTip: bigint
  /** Seconds from now until the burn can be released, without the tip and with it. */
  standardEtaSeconds: number
  tippedEtaSeconds: number
}

export async function quoteFasterProof(
  rt: Pick<Runtime, "node" | "l1" | "config" | "tuple">,
): Promise<FasterProof> {
  const estimate = await new WithdrawalSpeedupEstimator({
    node: rt.node as never,
    publicClient: rt.l1 as never,
  }).estimate(CLI_BURN_LANDING)
  const { proverTip } = await quoteWithdrawalProverTip(rt.l1 as never, {
    chainId: BigInt(rt.config.l1ChainId),
    proverSubsidy: rt.tuple.proverSubsidy as Address | undefined,
    checkpointCount: BigInt(estimate.checkpointIndex),
  })
  return {
    proverTip,
    standardEtaSeconds: estimate.standardEtaSeconds,
    tippedEtaSeconds: estimate.tippedEtaSeconds,
  }
}

export const minutes = (seconds: number) => `${Math.max(1, Math.round(seconds / 60))} min`

/** "about 4 min, 31 min without the tip" */
export const fasterEta = (faster: FasterProof) =>
  `about ${minutes(faster.tippedEtaSeconds)}, ${minutes(faster.standardEtaSeconds)} without the tip`
