import { WITHDRAW_RELAYER_TIP } from "@obsidion/core/constants"
import {
  predictAcrossBridgeEscrowAddressLocally,
  type AcrossBridgeEscrowArgs,
} from "@oxide/l1-contracts/across_bridge_on_withdraw.js"
import {
  CctpBridgeRoute,
  CctpFinality,
  predictCctpBridgeEscrowAddressLocally,
  type CctpBridgeEscrowArgs,
} from "@oxide/l1-contracts/cctp_bridge_on_withdraw.js"
import type { Address, Hex } from "viem"
import { describe, expect, it } from "vitest"
import type { WithdrawalRecord } from "../src/frontCore.ts"
import { CliError } from "../src/output.ts"
import {
  bridgeRoutes,
  bridgeState,
  bridgeSummary,
  escrowArgsOf,
  parseChain,
  routesTo,
  storedArgs,
  type BridgeTransfer,
  type BridgeView,
} from "../src/runtime/bridge.ts"
import { follow } from "../src/runtime/withdraw.ts"

const row = (rows: [string, string | undefined][], key: string) =>
  rows.find(([k]) => k === key)?.[1]

describe("bridge routes", () => {
  const on = (chain: string) =>
    bridgeRoutes()
      .filter((route) => route.chain === chain)
      .map(({ bridge, asset }) => `${bridge}:${asset}`)

  it("takes USDC and USDT through Across and USDC through CCTP, each route once", () => {
    expect(on("base")).toEqual(["across:USDC", "across:USDT", "cctp:USDC"])
    expect(on("plasma")).toEqual(["across:USDT"])
    expect(on("hyperCore")).toEqual(["cctp:USDC"])
    const keys = bridgeRoutes().map((r) => `${r.bridge}:${r.asset}:${r.chain}`)
    expect(new Set(keys).size).toBe(keys.length)
  })

  it("reads a chain in any case or by a common alias", () => {
    expect(parseChain("Base")).toBe("base")
    expect(parseChain("OP Mainnet")).toBe("opMainnet")
    expect(parseChain("optimism")).toBe("opMainnet")
    expect(parseChain("BSC")).toBe("bnb")
    expect(parseChain("hyperliquid")).toBe("hyperCore")
    expect(parseChain("world-chain")).toBe("worldChain")
    expect(() => parseChain("solana")).toThrow(CliError)
  })

  it("delivers USDC where it goes and USDT elsewhere, and names a route that does not exist", () => {
    expect(routesTo("base").map((r) => `${r.bridge}:${r.asset}`)).toEqual([
      "across:USDC",
      "cctp:USDC",
    ])
    expect(routesTo("plasma").map((r) => `${r.bridge}:${r.asset}`)).toEqual(["across:USDT"])
    expect(routesTo("base", "USDT").map((r) => r.bridge)).toEqual(["across"])
    expect(() => routesTo("plasma", undefined, "cctp")).toThrow(/CCTP does not reach plasma/)
    expect(() => routesTo("sonic", "USDT")).toThrow(/delivers USDT to sonic/)
  })
})

const ACROSS_FACTORY = "0x0aacb86083fb4c17c92c95f9b718f711b63d1987" as Address
const CCTP_FACTORY = "0x9beedf5117bdb9f3cd9d45f56a873ec87ab13b0d" as Address
const nonce = ("0x" + "11".repeat(32)) as Hex
const recoveryCommitment = ("0x" + "22".repeat(32)) as Hex
const recipient = "0x000000000000000000000000000000000000dEaD" as Address

const acrossArgs: AcrossBridgeEscrowArgs = {
  acrossInputToken: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
  destinationChainId: 56n,
  recipient,
  acrossOutputToken: "0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d",
  acrossOutputTokenDecimals: 18,
  acrossFee: 31_337n,
  recoveryCommitment,
  relayerTip: 880_000_000_000_000_000n,
  nonce,
}
const cctpArgs: CctpBridgeEscrowArgs = {
  route: CctpBridgeRoute.HyperCoreSpot,
  destinationDomain: 19,
  recipient,
  minFinalityThreshold: CctpFinality.Fast,
  maxFee: 270_000n,
  recoveryCommitment,
  relayerTip: 940_000_000_000_000_000n,
  nonce,
}

describe("escrow args in the store", () => {
  const roundTrip = (args: AcrossBridgeEscrowArgs | CctpBridgeEscrowArgs) =>
    escrowArgsOf({ escrowArgs: JSON.parse(JSON.stringify(storedArgs(args))) })

  it("rebuild the escrow they were stored from", () => {
    expect(
      predictAcrossBridgeEscrowAddressLocally(
        ACROSS_FACTORY,
        roundTrip(acrossArgs) as AcrossBridgeEscrowArgs,
      ),
    ).toBe(predictAcrossBridgeEscrowAddressLocally(ACROSS_FACTORY, acrossArgs))
    expect(
      predictCctpBridgeEscrowAddressLocally(
        CCTP_FACTORY,
        roundTrip(cctpArgs) as CctpBridgeEscrowArgs,
      ),
    ).toBe(predictCctpBridgeEscrowAddressLocally(CCTP_FACTORY, cctpArgs))
  })
})

const cut = 100_000_000_000_000_000n
const record: WithdrawalRecord = {
  localId: "wdraw_1",
  recipient: ("0x" + "4".repeat(40)) as Address,
  recipientProvenance: "saved-recipient",
  amount: "50",
  rawAmount: (50n * 10n ** 18n).toString(),
  relayerTip: WITHDRAW_RELAYER_TIP.toString(),
  fpcFundingCut: cut.toString(),
  tokenSymbol: "DAI",
  phase: "finalizing_l1",
  startTime: 1_700_000_000_000,
  l2TxHash: ("0x" + "0a".repeat(32)) as Hex,
  phaseEnteredAt: 1_700_000_000_000,
}
const transfer: BridgeTransfer = {
  bridge: "across",
  asset: "USDC",
  chain: "base",
  recipient,
  recipientAlias: "Ledger",
  amount: (50n * 10n ** 18n).toString(),
  withdrawalLocalId: "wdraw_1",
  factory: ACROSS_FACTORY,
  escrow: ("0x" + "4".repeat(40)) as Address,
  escrowArgs: storedArgs(acrossArgs),
  escrowTip: (880n * 10n ** 15n).toString(),
  bridgeFee: "10000",
  expected: "48900000",
  minReceived: "48410000",
  decimals: 6,
  scanFrom: "23000000",
}
const view = (
  over: Partial<BridgeTransfer> = {},
  rec: Partial<WithdrawalRecord> = {},
): BridgeView => ({
  id: "br-1",
  transfer: { ...transfer, ...over },
  record: { ...record, ...rec },
})
const runTxHash = ("0x" + "0b".repeat(32)) as Hex

describe("bridgeState", () => {
  const done = { phase: "done" as const, endTime: record.startTime }

  it("follows the burn, then waits for the run, then for the bridge", () => {
    expect(bridgeState(view(), record.startTime)).toEqual({
      label: "Releasing to Ethereum",
      settled: false,
    })
    expect(bridgeState(view({}, done), record.startTime).label).toBe(
      "waiting for the relayer to run the bridge",
    )
    expect(bridgeState(view({}, done), record.startTime + 31 * 60_000).label).toMatch(
      /`zkmoney bridges recover br-1` runs it yourself/,
    )
    expect(bridgeState(view({ runTxHash }, done))).toEqual({
      label: "Across is filling it on base",
      settled: false,
    })
    expect(
      bridgeState(
        view(
          { bridge: "cctp", runTxHash, delivery: { state: "pending", delay: "insufficient_fee" } },
          done,
        ),
      ).label,
    ).toBe("Circle is delivering it to base (held back: insufficient_fee)")
  })

  it("settles once it arrives, fails, comes back or is recovered", () => {
    expect(
      bridgeState(view({ runTxHash, delivery: { state: "arrived", txHash: runTxHash } })),
    ).toEqual({
      label: "arrived on base",
      settled: true,
    })
    const refunded = bridgeState(
      view({ runTxHash, delivery: { state: "refunded", txHash: runTxHash } }),
    )
    expect(refunded.settled).toBe(true)
    expect(refunded.label).toMatch(/`zkmoney bridges recover br-1 --to <address>`/)
    expect(bridgeState(view({ runTxHash, delivery: { state: "expired" } })).settled).toBe(false)
    expect(bridgeState(view({ recovered: { to: recipient, txHashes: [runTxHash] } })).settled).toBe(
      true,
    )
    expect(bridgeState(view({}, { phase: "failed", error: "boom" }))).toEqual({
      label: "the burn failed: boom",
      settled: true,
    })
  })
})

describe("bridgeSummary", () => {
  it("prices the DAI side and the bridge, and says what arrives where", () => {
    const rows = bridgeSummary(view(), { now: record.startTime })
    expect(row(rows, "Route")).toBe("USDC to base through Across")
    expect(row(rows, "Amount")).toBe("50.00 DAI")
    expect(row(rows, "Fees")).toBe("1.08 DAI, then 0.01 USDC to Across")
    expect(row(rows, "Receives")).toBe("about 48.90 USDC, at least 48.41 USDC")
    expect(row(rows, "To")).toBe("Ledger (0x0000…dEaD) on base")
    expect(row(rows, "Bridge tx")).toBeUndefined()
  })

  it("caps CCTP's fee and reads an 18-decimal delivery", () => {
    expect(row(bridgeSummary(view({ bridge: "cctp" })), "Fees")).toBe(
      "1.08 DAI, then up to 0.01 USDC to CCTP",
    )
    const bnb = view({
      asset: "USDT",
      chain: "bnb",
      decimals: 18,
      expected: (48_880n * 10n ** 15n).toString(),
      minReceived: (48_390n * 10n ** 15n).toString(),
    })
    expect(row(bridgeSummary(bnb), "Receives")).toBe("about 48.88 USDT, at least 48.39 USDT")
  })
})

describe("follow", () => {
  it("reports each change once and stops when done", async () => {
    const ticks = ["a", "a", "b", "done"]
    const seen: string[] = []
    const last = await follow(async () => ticks.shift()!, {
      key: (value) => value,
      done: (value) => value === "done",
      onChange: (value) => seen.push(value),
      intervalMs: 0,
    })
    expect(last).toBe("done")
    expect(seen).toEqual(["a", "b", "done"])
  })
})
