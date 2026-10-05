import { describe, expect, it } from "vitest"
import {
  Network,
  REGISTRATION_ASK_DEPOSIT_TOTAL,
  registrationFloor,
} from "@obsidion/core/constants"
import type { SipaFundingToken } from "../src/frontCore.ts"
import { sipaFundingTokens } from "../src/runtime/depositFacts.ts"
import {
  acceptedTokensLine,
  fundedInFeeUnits,
  fundingSummary,
  holdDeadline,
  phaseLabel,
  registrationKind,
  registrationQuote,
  renderDeposit,
  renderStatus,
  scheduleForRecord,
  signedSchedule,
  termsFromClaim,
} from "../src/runtime/registrationQuote.ts"

const DAI: SipaFundingToken = {
  address: "0x6B175474E89094C44Da98b954EedeAC495271d0F",
  symbol: "DAI",
  decimals: 18,
}
const [, USDC, USDT] = sipaFundingTokens(Network.MAINNET, DAI) as [
  SipaFundingToken,
  SipaFundingToken,
  SipaFundingToken,
]
const dai = (n: number) => BigInt(n) * 10n ** 18n

describe("funding tokens", () => {
  it("scale into the fee token: every accepted token has at most its decimals", () => {
    const tokens = sipaFundingTokens(Network.MAINNET, DAI)
    expect(tokens.map((t) => t.symbol)).toEqual(["DAI", "USDC", "USDT"])
    expect(tokens.every((t) => t.decimals <= DAI.decimals)).toBe(true)
  })
})

describe("signedSchedule", () => {
  it("prices nothing without both amounts, or at a zero quote", () => {
    expect(signedSchedule(undefined)).toBeUndefined()
    expect(signedSchedule({ fee: "1" })).toBeUndefined()
    expect(signedSchedule({ fee: "0", minDeposit: "0" })).toBeUndefined()
  })

  it("reads the signed amounts", () => {
    expect(signedSchedule({ fee: "5", minDeposit: "7" })).toEqual({ fee: 5n, min: 7n })
  })
})

describe("registrationQuote", () => {
  const schedule = { fee: dai(3), min: dai(2) }
  const cut = dai(1)

  it("asks the kind's figure with the floor beside it", () => {
    const quote = registrationQuote(schedule, "standard", cut)
    expect(quote.total).toBe(REGISTRATION_ASK_DEPOSIT_TOTAL.standard)
    expect(quote.floor).toBe(registrationFloor(schedule, cut))
    expect(quote.fee).toBe(dai(3))
    expect(quote.raised).toBe(false)
  })

  it("asks less for an earned tag", () => {
    const quote = registrationQuote(schedule, "earned_tag", cut)
    expect(quote.total).toBe(REGISTRATION_ASK_DEPOSIT_TOTAL.earned_tag)
    expect(quote.total).toBeLessThan(REGISTRATION_ASK_DEPOSIT_TOTAL.standard)
  })

  it("asks the floor when the deployment's floor outgrew the ask", () => {
    const steep = { fee: dai(20), min: dai(10) }
    const quote = registrationQuote(steep, "standard", cut)
    expect(quote.total).toBe(registrationFloor(steep, cut))
    expect(quote.raised).toBe(true)
  })

  it("knows no floor until the schedule and the cut are read", () => {
    expect(registrationQuote(undefined, "standard", cut)).toEqual({
      kind: "standard",
      total: REGISTRATION_ASK_DEPOSIT_TOTAL.standard,
      fee: undefined,
      raised: false,
    })
    expect(registrationQuote(schedule, "standard", undefined).floor).toBeUndefined()
  })

  it("names the kind from the reduced flag alone", () => {
    expect(registrationKind(true)).toBe("earned_tag")
    expect(registrationKind(false)).toBe("standard")
    expect(registrationKind(undefined)).toBe("standard")
  })
})

describe("terms", () => {
  const claim = {
    signature: "0xab" as const,
    nonce: "1",
    deadline: "1759000000",
    hold: { deadline: "1760000000" },
    terms: {
      fee: "3",
      minDeposit: "2",
      nonce: "9",
      deadline: "1759000500",
      signature: "0xcd" as const,
      reduced: true,
      ticket: false,
    },
  }

  it("keeps the hold, the claim deadline and the signed amounts from the sign response", () => {
    expect(termsFromClaim("0xACC", "alice", claim)).toEqual({
      account: "0xACC",
      tag: "alice",
      claimDeadline: 1759000000,
      holdDeadline: 1760000000,
      fee: "3",
      minDeposit: "2",
      reduced: true,
    })
    expect(
      termsFromClaim("0xACC", "alice", { ...claim, hold: undefined, terms: undefined }),
    ).toEqual({
      account: "0xACC",
      tag: "alice",
      claimDeadline: 1759000000,
    })
  })

  it("prices a record off the schedule that names its committed fee", () => {
    const chain = { fee: 10n, min: 4n }
    const signed = termsFromClaim("0xACC", "alice", claim)
    expect(scheduleForRecord({ fee: "3" }, signed, chain)).toEqual({ fee: 3n, min: 2n })
    expect(scheduleForRecord({ fee: "10" }, signed, chain)).toEqual(chain)
    expect(scheduleForRecord({ fee: "7" }, signed, chain)).toBeUndefined()
    expect(scheduleForRecord({}, undefined, chain)).toEqual(chain)
  })
})

describe("holdDeadline", () => {
  it("reads the reservation hold in unix seconds", () => {
    expect(holdDeadline({ hold: { deadline: "1760000000" } })).toBe(1760000000)
  })

  it("is absent without a hold or with a malformed one", () => {
    expect(holdDeadline({})).toBeUndefined()
    expect(holdDeadline({ hold: { deadline: "soon" } })).toBeUndefined()
  })
})

describe("funding", () => {
  it("summarises what the address holds, per token", () => {
    expect(fundingSummary([{ token: DAI, balance: 0n }])).toBe("nothing yet")
    expect(
      fundingSummary([
        { token: DAI, balance: dai(1) },
        { token: USDC, balance: 3_000_000n },
        { token: USDT, balance: 0n },
      ]),
    ).toBe("1.00 DAI, 3.00 USDC")
  })

  it("scales the largest balance into fee-token units", () => {
    expect(
      fundedInFeeUnits(DAI, [
        { token: DAI, balance: dai(1) },
        { token: USDC, balance: 3_000_000n },
      ]),
    ).toBe(dai(3))
  })

  it("says which tokens are taken and what they swap into", () => {
    expect(acceptedTokensLine([DAI, USDC, USDT])).toBe(
      "DAI, USDC, USDT (USDC and USDT are swapped to DAI)",
    )
    expect(acceptedTokensLine([DAI])).toBe("DAI")
  })
})

describe("rendering", () => {
  const sipa = "0x1111111111111111111111111111111111111111"
  const l1Account = "0x2222222222222222222222222222222222222222"

  it("prints the deposit instructions with the amount, the tokens and the hold", () => {
    const out = renderDeposit({
      tag: "alice",
      ensDomain: "zk.money",
      sipaAddress: sipa,
      chainName: "Ethereum",
      l1Account,
      feeToken: DAI,
      fundingTokens: [DAI, USDC, USDT],
      quote: { kind: "standard", total: dai(15), floor: dai(5), fee: dai(3), raised: false },
      holdDeadline: Date.parse("2026-10-07T10:00:00Z"),
      claimDeadline: Date.parse("2026-09-30T20:00:00Z"),
      broadcast: true,
    })
    expect(out).toContain("@alice  (alice.zk.money)")
    expect(out).toContain(sipa)
    expect(out).toContain("15.00 DAI  (at least 5.00 DAI)")
    expect(out).toContain("DAI, USDC, USDT")
    expect(out).toContain("3.00 DAI tag fee")
    expect(out).toContain("Hold until")
    expect(out).toMatch(/Relayers\s+notified/)
    expect(out).not.toContain("floor is above the usual ask")
  })

  it("omits what it does not know and flags a raised ask", () => {
    const out = renderDeposit({
      tag: "bob",
      ensDomain: "zk.money",
      sipaAddress: sipa,
      chainName: "Ethereum",
      l1Account,
      feeToken: DAI,
      fundingTokens: [DAI],
      quote: { kind: "earned_tag", total: dai(7), floor: dai(7), fee: dai(2), raised: true },
      broadcast: false,
    })
    expect(out).not.toContain("Hold until")
    expect(out).toContain("(earned tag)")
    expect(out).toContain("7.00 DAI\n")
    expect(out).toContain("floor is above the usual ask")
    expect(out).toContain("not notified yet")
  })

  it("prints the status with the phase, the funding verdict and the registry", () => {
    const out = renderStatus({
      tag: "alice",
      phase: "funded",
      sipaAddress: sipa,
      l1Account,
      feeToken: DAI,
      balances: [
        { token: DAI, balance: 0n },
        { token: USDC, balance: 15_000_000n },
      ],
      floor: dai(5),
      swept: false,
      broadcast: true,
      holdDeadline: Date.parse("2026-10-07T10:00:00Z"),
      registered: false,
      full: true,
    })
    expect(out).toContain("deposit seen, waiting for a relayer to sweep it")
    expect(out).toContain("15.00 USDC  (covers the floor)")
    expect(out).toContain(sipa)
    expect(out).toMatch(/Registry\s+not yet/)
  })

  it("names a lost race and a short deposit", () => {
    const out = renderStatus({
      tag: "alice",
      phase: "failed_taken",
      sipaAddress: sipa,
      l1Account,
      feeToken: DAI,
      balances: [{ token: DAI, balance: dai(1) }],
      floor: dai(5),
      swept: false,
      broadcast: false,
      registered: null,
    })
    expect(out).toContain(phaseLabel("failed_taken"))
    expect(out).toContain("1.00 DAI  (below the floor)")
    expect(out).toContain("names another account")
    expect(out).toContain("0x1111…1111")
  })
})
