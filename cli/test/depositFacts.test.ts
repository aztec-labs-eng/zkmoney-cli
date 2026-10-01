import { describe, expect, it } from "vitest"
import { parseUnits } from "viem"
import { Network } from "@obsidion/core/constants"
import type { SIPADepositRecord } from "../src/frontCore.ts"
import {
  depositPhaseLabel,
  fundingTokenNamed,
  recordAmount,
  requestWindowError,
  rescale,
  sipaFundingTokens,
} from "../src/runtime/depositFacts.ts"

const DAI = {
  address: "0x6B175474E89094C44Da98b954EedeAC495271d0F" as const,
  symbol: "DAI",
  decimals: 18,
}

describe("sipaFundingTokens", () => {
  it("offers the mainnet swap inputs after the manifest token", () => {
    const tokens = sipaFundingTokens(Network.MAINNET, DAI)
    expect(tokens.map((t) => t.symbol)).toEqual(["DAI", "USDC", "USDT"])
    expect(tokens[1]).toMatchObject({
      address: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
      decimals: 6,
    })
    expect(tokens[2]).toMatchObject({
      address: "0xdac17f958d2ee523a2206206994597c13d831ec7",
      decimals: 6,
    })
  })

  it("accepts only the portal's own token elsewhere", () => {
    const test = { ...DAI, symbol: "TEST" }
    expect(sipaFundingTokens(Network.SANDBOX, test)).toEqual([test])
    expect(sipaFundingTokens(Network.TESTNET, test)).toEqual([test])
  })

  it("finds a token by symbol whatever the case", () => {
    const tokens = sipaFundingTokens(Network.MAINNET, DAI)
    expect(fundingTokenNamed(tokens, "usdc")?.symbol).toBe("USDC")
    expect(fundingTokenNamed(tokens, "ETH")).toBeUndefined()
  })
})

describe("requestWindowError", () => {
  const fee = parseUnits("0.5", 18)
  const cap = parseUnits("10000", 18)

  it("refuses a request the fee would eat", () => {
    expect(requestWindowError(fee, fee, cap, 18, "DAI")).toMatch(
      /exceed the deposit fee \(0.5 DAI\)/,
    )
    expect(requestWindowError(fee + 1n, fee, cap, 18, "DAI")).toBeUndefined()
  })

  it("refuses a request over the cap, net of the fee", () => {
    expect(requestWindowError(cap + fee, fee, cap, 18, "DAI")).toBeUndefined()
    expect(requestWindowError(cap + fee + 1n, fee, cap, 18, "DAI")).toMatch(/maximum per deposit/)
  })

  it("compares a six-decimal request one to one", () => {
    const usdcFee = rescale(fee, 18, 6)
    expect(usdcFee).toBe(500_000n)
    expect(requestWindowError(parseUnits("25", 6), usdcFee, cap, 6, "USDC")).toBeUndefined()
    expect(requestWindowError(parseUnits("10001", 6), usdcFee, cap, 6, "USDC")).toMatch(/maximum/)
  })
})

const record = (over: Partial<SIPADepositRecord>): SIPADepositRecord => ({
  sipaAddress: "0x0000000000000000000000000000000000000001",
  recipientL2Address: "0x1",
  messageSecret: "0x2",
  recipientHash: "0x3",
  recoveryAddress: "",
  l1ChainId: 1,
  amount: "0",
  tokenSymbol: "DAI",
  phase: "resolved",
  startTime: 0,
  ...over,
})

describe("depositPhaseLabel", () => {
  it("reads an unpaid address as awaiting whatever phase it was created in", () => {
    expect(depositPhaseLabel(record({ phase: "resolved" }))).toBe("awaiting")
    expect(depositPhaseLabel(record({ phase: "broadcast" }))).toBe("awaiting")
  })

  it("counts a live holding the store has not seen", () => {
    expect(depositPhaseLabel(record({ phase: "broadcast" }), 1n)).toBe("funded")
    expect(depositPhaseLabel(record({ phase: "broadcast", amount: "5" }))).toBe("funded")
  })

  it("follows the record past the sweep", () => {
    expect(depositPhaseLabel(record({ phase: "broadcast", sweepTxHash: "0x9" }))).toBe("sweeping")
    expect(depositPhaseLabel(record({ phase: "sweeping" }))).toBe("sweeping")
    expect(depositPhaseLabel(record({ phase: "pendingClaim" }))).toBe("crediting")
    expect(depositPhaseLabel(record({ phase: "claimed" }))).toBe("credited")
    expect(depositPhaseLabel(record({ phase: "recoverable" }))).toBe("needs recovery")
    expect(depositPhaseLabel(record({ phase: "recovered" }))).toBe("recovered")
    expect(depositPhaseLabel(record({ phase: "failed" }))).toBe("failed")
  })
})

describe("recordAmount", () => {
  it("is empty while nothing was recorded", () => {
    expect(recordAmount(record({}), 18)).toBeUndefined()
  })

  it("shows the gross before the sweep and the net after", () => {
    expect(recordAmount(record({ amount: "25", tokenDecimals: 6, tokenSymbol: "USDC" }), 18)).toBe(
      "25.00 USDC",
    )
    expect(
      recordAmount(record({ amount: "24.5", netAmount: parseUnits("24.5", 18).toString() }), 18),
    ).toBe("24.50 DAI")
  })
})
