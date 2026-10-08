import { existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createPXE } from "@aztec/pxe/server"
import { WITHDRAW_RELAYER_TIP } from "@obsidion/core/constants"
import {
  swappedAtFloor,
  swappedAtPeg,
} from "@oxide/oxide-client/withdraw_escrows/escrow_withdrawal.js"
import type { Address } from "viem"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { unlockAccount } from "../src/keystore/keystore.ts"
import { bootReadOnly, type ReadOnlyRuntime } from "../src/runtime/boot.ts"
import { quoteBridgeTransfer, quoteSummary, type BridgeQuote } from "../src/runtime/bridge.ts"

const DAI_UNIT = 10n ** 18n
const USDC_UNIT = 10n ** 6n

/** What the network answers, set per test: the fee APIs, Hyperliquid, the relayer's run price, the portal. */
const network = vi.hoisted(() => ({
  across: {} as {
    totalRelayFeePct: bigint
    relayerGasFeePct: bigint
    relayerGasFee: bigint
    acrossOutputTokenDecimals: number
    minDeposit: bigint
    maxDeposit: bigint
  },
  cctp: [] as {
    finalityThreshold: number
    minimumFee: number
    forwardFee?: { low: bigint; med: bigint; high: bigint }
  }[],
  hyperCoreAccountExists: false,
  /** The relayer's floor for running an escrow, before the wallet's margin. */
  runFloor: 0n,
  fpcFundingCut: 0n,
  proverTip: 0n,
}))

vi.mock("@oxide/oxide-client/withdraw_escrows/across_api.js", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  fetchAcrossFees: async () => network.across,
}))
vi.mock("@oxide/oxide-client/withdraw_escrows/cctp_api.js", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  fetchCctpFees: async () => network.cctp,
}))
vi.mock("@oxide/oxide-client/withdraw_escrows/hypercore_api.js", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  fetchHyperCoreAccountExists: async () => network.hyperCoreAccountExists,
}))
vi.mock("@oxide/oxide-client/l1_operation_quote.js", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  quoteL1Operation: async () => ({ minPayout: network.runFloor }),
}))
vi.mock("@obsidion/sdk", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  findBalanceOfSlot: async () => 2n,
  readFpcFundingCut: async () => network.fpcFundingCut,
  quoteWithdrawalProverTip: async () => ({ proverTip: network.proverTip }),
}))
vi.mock("../src/frontCore.ts", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  WithdrawalSpeedupEstimator: class {
    async estimate() {
      return { checkpointIndex: 3, standardEtaSeconds: 31 * 60, tippedEtaSeconds: 4 * 60 }
    }
  },
}))
// A quote must never open a PXE or unlock the keystore; these fail the test if it does.
vi.mock("@aztec/pxe/server", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  createPXE: vi.fn(async () => {
    throw new Error("a quote opened a PXE")
  }),
}))
vi.mock("../src/keystore/keystore.ts", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  unlockAccount: vi.fn(() => {
    throw new Error("a quote unlocked the keystore")
  }),
}))
const boot = vi.hoisted(() => ({ home: "" }))
vi.mock("../src/config.ts", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  loadConfig: async () => ({ ...CONFIG, home: boot.home }),
}))
vi.mock("@obsidion/core/oxide", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  loadOxideManifestTuple: async () => TUPLE,
}))

const DAI = "0x6B175474E89094C44Da98b954EedeAC495271d0F" as Address
const FEED = ("0x" + "5f".repeat(20)) as Address
const RECIPIENT = "0x000000000000000000000000000000000000dEaD"
const TUPLE = {
  token: DAI,
  portal: "0xdf410ad448A0f7165181FBdB32f8896f4a0d9449",
  withdrawalSubsidy: "0x" + "51".repeat(20),
  operationExecutor: "0x" + "0e".repeat(20),
  proverSubsidy: "0x" + "9b".repeat(20),
}
const CONFIG = {
  network: "mainnet",
  l1ChainId: 1,
  l1RpcUrl: { value: "http://127.0.0.1:1", source: "flag" },
  nodeUrl: { value: "http://127.0.0.1:1", source: "flag" },
  oxide: { manifestUrl: "http://127.0.0.1:1/manifest.json", portal: TUPLE.portal },
  addressOverrides: {},
  bridgeEscrowFactories: {
    across: { value: "0x0aacb86083fb4c17c92c95f9b718f711b63d1987", source: "env" },
    cctp: { value: "0x9beedf5117bdb9f3cd9d45f56a873ec87ab13b0d", source: "env" },
  },
}

/** Anything but these on the runtime, or anything but a contract read on L1, fails the quote. */
const READS = ["config", "network", "node", "tuple", "l1", "l1Chain"]
function readOnlyRuntime(l1Calls: string[]): ReadOnlyRuntime {
  const l1 = new Proxy(
    {
      readContract: async ({ functionName }: { functionName: string }) =>
        functionName === "DAI" ? DAI : FEED,
    },
    {
      get(target, key) {
        if (key === "then") return undefined
        if (key !== "readContract") throw new Error(`the quote called L1 ${String(key)}`)
        l1Calls.push(key)
        return Reflect.get(target, key)
      },
    },
  )
  const untouchable = new Proxy(
    {},
    {
      get(_, key) {
        if (key === "then") return undefined
        throw new Error(`the quote used the node's ${String(key)}`)
      },
    },
  )
  return new Proxy(
    { config: CONFIG, network: "mainnet", node: untouchable, tuple: TUPLE, l1, l1Chain: {} },
    {
      get(target, key) {
        if (key === "then") return undefined
        if (typeof key === "string" && !READS.includes(key))
          throw new Error(`the quote reached for ${key}`)
        return Reflect.get(target, key)
      },
    },
  ) as unknown as ReadOnlyRuntime
}

const quoteOf = async (input: {
  amount: string
  chain: string
  via?: string
  asset?: string
  faster?: boolean
}) => (await quoteBridgeTransfer(readOnlyRuntime([]), { to: RECIPIENT, ...input })).quote

/** The escrow's own arithmetic over what the quote says it swaps. */
const funding = (quote: BridgeQuote) => ({
  amount: quote.amount,
  withdrawalRelayerTip: quote.releaseTip,
  proverTip: quote.proverTip,
  fpcFundingCut: quote.fpcFundingCut,
  relayerTip: quote.escrowTip,
})

beforeEach(() => {
  network.across = {
    totalRelayFeePct: 3n * 10n ** 14n,
    relayerGasFeePct: 10n ** 14n,
    relayerGasFee: 4_000n,
    acrossOutputTokenDecimals: 6,
    minDeposit: USDC_UNIT,
    maxDeposit: 10n ** 12n,
  }
  network.cctp = [
    {
      finalityThreshold: 1000,
      minimumFee: 1,
      forwardFee: { low: 100_000n, med: 150_000n, high: 200_000n },
    },
  ]
  network.hyperCoreAccountExists = false
  network.runFloor = 800n * 10n ** 15n
  network.fpcFundingCut = 100n * 10n ** 15n
  network.proverTip = 400n * 10n ** 15n
})

describe("bridges quote: fees", () => {
  it("itemises every DAI fee, and they and the swap add up to the amount", async () => {
    for (const via of ["across", "cctp"])
      for (const faster of [false, true]) {
        const quote = await quoteOf({ amount: "50", chain: "base", via, faster })
        expect(quote.releaseTip).toBe(WITHDRAW_RELAYER_TIP)
        expect(quote.fpcFundingCut).toBe(network.fpcFundingCut)
        expect(quote.proverTip).toBe(faster ? network.proverTip : 0n)
        // The run's floor plus the wallet's 10% margin.
        expect(quote.escrowTip).toBe(880n * 10n ** 15n)
        expect(
          quote.releaseTip +
            quote.fpcFundingCut +
            quote.proverTip +
            quote.escrowTip +
            quote.swapInput,
        ).toBe(50n * DAI_UNIT)
      }
  })

  it("delivers the escrow's swap less the bridge fee: at 1:1 expected, at the floor the minimum", async () => {
    const across = await quoteOf({ amount: "50", chain: "base", via: "across" })
    expect(across.activationFee).toBe(0n)
    expect(across.expected + across.bridgeFee).toBe(swappedAtPeg(funding(across)))
    expect(across.minReceived + across.bridgeFee).toBe(swappedAtFloor(funding(across)))

    const hyperCore = await quoteOf({ amount: "50", chain: "hyperCore" })
    expect(hyperCore.activationFee).toBe(USDC_UNIT)
    expect(hyperCore.expected + hyperCore.bridgeFee + hyperCore.activationFee).toBe(
      swappedAtPeg(funding(hyperCore)),
    )
    expect(hyperCore.minReceived + hyperCore.bridgeFee + hyperCore.activationFee).toBe(
      swappedAtFloor(funding(hyperCore)),
    )
    network.hyperCoreAccountExists = true
    expect((await quoteOf({ amount: "50", chain: "hyperCore" })).activationFee).toBe(0n)
  })

  it("scales an 18-decimal delivery from Across's 6-decimal deposit", async () => {
    network.across.acrossOutputTokenDecimals = 18
    const bnb = await quoteOf({ amount: "50", chain: "bnb", asset: "USDT" })
    expect(bnb.decimals).toBe(18)
    expect(bnb.expected).toBe((swappedAtPeg(funding(bnb)) - bnb.bridgeFee) * 10n ** 12n)
  })

  it("takes --faster's prover tip out of the swap and nothing else", async () => {
    const plain = await quoteOf({ amount: "50", chain: "base", via: "across" })
    const faster = await quoteOf({ amount: "50", chain: "base", via: "across", faster: true })
    expect(faster.proverTip).toBe(network.proverTip)
    expect(faster.escrowTip).toBe(plain.escrowTip)
    expect(faster.swapInput).toBe(plain.swapInput - network.proverTip)
  })

  it("takes the route that delivers the most at the floor", async () => {
    const [best, across, cctp] = await Promise.all(
      [undefined, "across", "cctp"].map((via) => quoteOf({ amount: "50", chain: "base", via })),
    )
    expect(best!.minReceived).toBe(
      across!.minReceived > cctp!.minReceived ? across!.minReceived : cctp!.minReceived,
    )
  })

  it("prints each item, the proof's wait both ways, and when it was priced", async () => {
    const quoted = await quoteBridgeTransfer(readOnlyRuntime([]), {
      amount: "50",
      to: RECIPIENT,
      chain: "hyperCore",
      faster: true,
    })
    const { facts, items, proof } = quoteSummary({
      ...quoted,
      quotedAt: new Date("2026-10-08T18:02:11.500Z"),
    })
    const item = (label: string) => items.find(([l]) => l === label)?.slice(1)
    expect(facts[0]).toEqual(["Quoted", "2026-10-08 18:02:11 UTC"])
    expect(facts.find(([l]) => l === "Spend")?.[1]).toBe("50.0000 DAI, fees included")
    expect(item("Release tip")?.[0]).toBe("0.1000 DAI")
    expect(item("Portal cut")?.[0]).toBe("0.1000 DAI")
    expect(item("Prover tip")?.[0]).toBe("0.4000 DAI")
    expect(item("Escrow run")?.[0]).toBe("0.8800 DAI")
    expect(item("Swapped")?.[0]).toBe("48.5200 DAI")
    expect(item("Activation fee")).toEqual(["1.0000 USDC", "hyperCore's fee on a first deposit"])
    expect(proof).toBe("about 4 min with the prover tip, 31 min without")
    const plain = quoteSummary(
      await quoteBridgeTransfer(readOnlyRuntime([]), {
        amount: "50",
        to: RECIPIENT,
        chain: "base",
      }),
    )
    expect(plain.items.some(([l]) => l === "Prover tip")).toBe(false)
    expect(plain.proof).toBe("about 31 min; 4 min with --faster, for a 0.4000 DAI prover tip")
  })
})

describe("bridges quote: refusals", () => {
  it("refuses an amount below the withdrawal fees", async () => {
    await expect(quoteOf({ amount: "0.15", chain: "base" })).rejects.toThrow(
      "0.15 DAI does not cover the withdrawal fees of 0.20 DAI",
    )
  })

  it("refuses an amount that cannot pay for the escrow's run", async () => {
    network.runFloor = 10n * DAI_UNIT
    await expect(quoteOf({ amount: "5", chain: "base", via: "across" })).rejects.toThrow(
      "after the withdrawal fees, the 4.80 DAI left does not cover running the escrow, which costs 11.00 DAI",
    )
  })

  it("names Across's limits", async () => {
    network.across.minDeposit = 10n * USDC_UNIT
    await expect(quoteOf({ amount: "5", chain: "base", via: "across" })).rejects.toThrow(
      /Across takes at least 10.00 USDC a deposit on this route, and this could deposit as little as 4\.75 USDC/,
    )
    network.across.minDeposit = USDC_UNIT
    network.across.maxDeposit = 20n * USDC_UNIT
    await expect(quoteOf({ amount: "50", chain: "base", via: "across" })).rejects.toThrow(
      /Across takes at most 20.00 USDC a deposit on this route/,
    )
  })

  it("names the destination's minimum, the activation fee included", async () => {
    await expect(quoteOf({ amount: "2.50", chain: "hyperCore" })).rejects.toThrow(
      "hyperCore needs at least 1.00 USDC to arrive, and after Circle's fee and the 1.00 USDC activation fee less would",
    )
  })

  it("takes only an address", async () => {
    await expect(quoteOf({ amount: "5", chain: "base", to: "bob" } as never)).rejects.toThrow(
      /is not an address/,
    )
  })
})

describe("bridges quote: read-only", () => {
  it("prices from reads alone: no account, store, wallet, node call or L1 write", async () => {
    const l1Calls: string[] = []
    const rt = readOnlyRuntime(l1Calls)
    await quoteBridgeTransfer(rt, { amount: "50", to: RECIPIENT, chain: "base", faster: true })
    await quoteBridgeTransfer(rt, { amount: "50", to: RECIPIENT, chain: "hyperCore" })
    expect(new Set(l1Calls)).toEqual(new Set(["readContract"]))
  })

  it("boots without a PXE, the keystore or the home directory", async () => {
    boot.home = join(tmpdir(), `zkmoney-quote-${process.pid}-${Date.now()}`)
    const rt = await bootReadOnly({ home: boot.home })
    expect(Object.keys(rt).sort()).toEqual([...READS].sort())
    expect(createPXE).not.toHaveBeenCalled()
    expect(unlockAccount).not.toHaveBeenCalled()
    expect(existsSync(boot.home)).toBe(false)
  })
})
