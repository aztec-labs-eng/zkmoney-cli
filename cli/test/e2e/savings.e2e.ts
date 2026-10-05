/**
 * Savings moves end to end on a live network, through its relayers. A move into Savings buys its own early proof. A
 * move back cannot, since its prover would be paid in sUSDS, so a tipped DAI withdrawal sent right after it buys a
 * proof that covers its burn too. Each leg prints how long it took; without an early proof it waits for its epoch's.
 *
 * Needs a home whose account has a registered tag and DAI, and a profile naming the Savings deployment and its
 * escrow factory, directly or through the `addresses.*` settings:
 *
 *   ZKMONEY_E2E_HOME=<home> [ZKMONEY_E2E_PROFILE=dev] [ZKMONEY_E2E_SPEEDUP_TO=<address>] pnpm test:e2e
 */
import { formatUnits, parseUnits } from "viem"
import { afterAll, beforeAll, expect, it } from "vitest"
import { boot, type Runtime } from "../../src/runtime/boot.ts"
import { quoteFasterProof } from "../../src/runtime/fasterProof.ts"
import {
  moveThroughSky,
  readSavings,
  recoveryAccountOf,
  savingsRuntime,
  settleMoves,
  sharesFor,
} from "../../src/runtime/savings.ts"
import { stopTracking, withdraw } from "../../src/runtime/withdraw.ts"

const MINUTE = 60_000
/** An epoch is 38 minutes on testnet and its proof lands minutes later; claiming takes a few more. */
const CLAIM_WITHIN = 60 * MINUTE
const home = process.env.ZKMONEY_E2E_HOME
const profile = process.env.ZKMONEY_E2E_PROFILE ?? "dev"
const quiet = () => {}

let rt: Runtime
let sv: Runtime

beforeAll(async () => {
  if (!home)
    throw new Error("set ZKMONEY_E2E_HOME to a home whose account has a registered tag and DAI")
  rt = await boot({ home, profile })
  sv = await savingsRuntime(rt)
}, 15 * MINUTE)

afterAll(async () => {
  if (!rt) return
  await stopTracking(rt)
  await rt.close()
})

/** Settles moves until `id` is claimed, and logs how long the move took from its burn. */
async function claimed(id: string, burnedAt: number): Promise<void> {
  while (!(await settleMoves(rt, sv)).find((m) => m.id === id)?.move.deposit?.claimed) {
    if (Date.now() - burnedAt > CLAIM_WITHIN)
      throw new Error(`move ${id} was not claimed in ${CLAIM_WITHIN / MINUTE} min`)
    await new Promise((resolve) => setTimeout(resolve, 30_000))
  }
  console.log(`${id} claimed ${Math.round((Date.now() - burnedAt) / MINUTE)} min after its burn`)
}

it(
  "moves DAI into Savings with an early proof",
  async () => {
    const before = await readSavings(sv)
    // The tip is quoted again inside the move; 10 DAI covers the other tips and any drift.
    const { proverTip } = await quoteFasterProof(rt)
    const { id, faster } = await moveThroughSky(
      rt,
      sv,
      {
        direction: "in",
        amountAtomic: proverTip + parseUnits("10", 18),
        key: `e2e-in-${Date.now()}`,
        faster: true,
      },
      quiet,
    )
    const burnedAt = Date.now()
    expect(faster).toBeDefined()
    await claimed(id, burnedAt)
    expect((await readSavings(sv)).shares).toBeGreaterThan(before.shares)
  },
  CLAIM_WITHIN + 15 * MINUTE,
)

it(
  "moves Savings back to Main, with a tipped withdrawal buying its proof",
  async () => {
    const main = await rt.tokenService()
    const out = await moveThroughSky(
      rt,
      sv,
      {
        direction: "out",
        amountAtomic: await sharesFor(sv, parseUnits("2", 18)),
        key: `e2e-out-${Date.now()}`,
      },
      quiet,
    )
    const burnedAt = Date.now()
    // Any DAI withdrawal with a tip will do; by default its funds stay with the account on L1.
    const { proverTip } = await quoteFasterProof(rt)
    await withdraw(
      rt,
      {
        amount: formatUnits(proverTip + parseUnits("1", 18), 18),
        to: process.env.ZKMONEY_E2E_SPEEDUP_TO ?? (await recoveryAccountOf(rt)),
        asset: "DAI",
        key: `e2e-speedup-${Date.now()}`,
        faster: true,
      },
      quiet,
    )
    const before = await main.getBalance()
    await claimed(out.id, burnedAt)
    expect(await main.getBalance()).toBeGreaterThan(before)
  },
  CLAIM_WITHIN + 15 * MINUTE,
)
