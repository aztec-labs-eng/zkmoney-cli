import { WITHDRAW_RELAYER_TIP } from "@obsidion/core/constants"
import type { Hex } from "viem"
import type { Contact, WithdrawalRecord } from "../src/frontCore.ts"
import { describe, expect, it } from "vitest"
import { CliError } from "../src/output.ts"
import {
  matchL1Contact,
  parseWithdrawAsset,
  phaseLabel,
  predicateConfigFromEnv,
  withdrawalSummary,
} from "../src/runtime/withdraw.ts"

const row = (rows: [string, string | undefined][], key: string) =>
  rows.find(([k]) => k === key)?.[1]

describe("predicateConfigFromEnv", () => {
  const full = {
    ZKMONEY_PREDICATE_VERIFICATION_HASH: "x-managed-policy-1",
    ZKMONEY_PREDICATE_CHAIN: "ethereum-mainnet",
    ZKMONEY_PREDICATE_API_KEY: "k",
  }

  it("arms screening from the three variables, with an optional base url", () => {
    expect(predicateConfigFromEnv(full)).toEqual({
      verificationHash: "x-managed-policy-1",
      chain: "ethereum-mainnet",
      apiKey: "k",
    })
    expect(
      predicateConfigFromEnv({ ...full, ZKMONEY_PREDICATE_BASE_URL: "https://staging.api" })
        ?.baseUrl,
    ).toBe("https://staging.api")
  })

  it("screens nothing when nothing is set", () => {
    expect(predicateConfigFromEnv({})).toBeUndefined()
  })

  it("refuses a partial setup anywhere", () => {
    const partial = { ZKMONEY_PREDICATE_VERIFICATION_HASH: "h" }
    expect(() => predicateConfigFromEnv(partial)).toThrow(/half configured/)
    expect(() => predicateConfigFromEnv(partial)).toThrow(CliError)
  })
})

describe("parseWithdrawAsset", () => {
  it("takes the four assets in any case and nothing else", () => {
    expect(parseWithdrawAsset("dai")).toBe("DAI")
    expect(parseWithdrawAsset(" ETH ")).toBe("ETH")
    expect(() => parseWithdrawAsset("BTC")).toThrow(/not a withdrawal asset/)
  })
})

describe("matchL1Contact", () => {
  const book: Contact[] = [
    { name: "Alice", address: "0x" + "1".repeat(64), tag: "alice" },
    {
      name: "Ledger",
      address: "0x" + "2".repeat(40),
      addressKind: "ethereum-l1",
      l1Wallet: { provider: "manual", provenance: "saved-recipient" },
    },
    {
      name: "Old",
      address: "0x" + "3".repeat(40),
      addressKind: "ethereum-l1",
      l1Wallet: { provider: "manual", provenance: "saved-recipient", deletedAt: 1 },
    },
  ]

  it("finds a live Ethereum contact by name only", () => {
    expect(matchL1Contact(book, "ledger")?.address).toBe("0x" + "2".repeat(40))
    expect(matchL1Contact(book, "alice")).toBeUndefined()
    expect(matchL1Contact(book, "old")).toBeUndefined()
  })
})

const cut = 50_000_000_000_000_000n
const base: WithdrawalRecord = {
  localId: "wdraw_1",
  recipient: "0x000000000000000000000000000000000000dEaD",
  recipientProvenance: "saved-recipient",
  amount: "100",
  rawAmount: (100n * 10n ** 18n).toString(),
  relayerTip: WITHDRAW_RELAYER_TIP.toString(),
  fpcFundingCut: cut.toString(),
  tokenSymbol: "DAI",
  phase: "finalizing_l1",
  startTime: 1_700_000_000_000,
  l2TxHash: ("0x" + "0a".repeat(32)) as Hex,
  phaseEnteredAt: 1_700_000_000_000,
}

describe("withdrawalSummary", () => {
  it("prices a direct withdrawal: gross, fee, net", () => {
    const rows = withdrawalSummary(base, { now: base.startTime })
    expect(row(rows, "Amount")).toBe("100.00 DAI")
    expect(row(rows, "Fee")).toBe("0.15 DAI")
    expect(row(rows, "Receives")).toBe("99.85 DAI")
    expect(row(rows, "To")).toBe("0x0000…dEaD")
    expect(row(rows, "Phase")).toBe("finalizing_l1: Releasing to Ethereum")
    expect(row(rows, "Escrow")).toBeUndefined()
  })

  it("shows a swap's estimate in the output asset", () => {
    const swap: WithdrawalRecord = {
      ...base,
      swapOutput: "USDC",
      swapEscrow: ("0x" + "4".repeat(40)) as Hex,
      swapRelayerTip: (2n * 10n ** 18n).toString(),
      swapEstimatedOut: "97600000",
      swapOutputDecimals: 6,
      recipientAlias: "Ledger",
    }
    const rows = withdrawalSummary(swap, { now: base.startTime })
    expect(row(rows, "Fee")).toBe("2.15 DAI")
    expect(row(rows, "Receives")).toBe("about 97.60 USDC")
    expect(row(rows, "To")).toBe("Ledger (0x0000…dEaD)")
    expect(row(rows, "Escrow")).toBe("0x4444…4444")
  })

  it("hides the breakdown when the record carries no fee", () => {
    const rows = withdrawalSummary({ ...base, relayerTip: undefined, fpcFundingCut: undefined })
    expect(row(rows, "Fee")).toBeUndefined()
    expect(row(rows, "Receives")).toBeUndefined()
  })
})

describe("phaseLabel", () => {
  it("names the proof before a hash and flags a long wait", () => {
    expect(phaseLabel({ ...base, phase: "submitting", l2TxHash: undefined })).toBe(
      "Proving privately",
    )
    expect(phaseLabel(base, base.startTime + 2 * 60 * 60 * 1000)).toBe(
      "Releasing to Ethereum (taking longer than usual)",
    )
    expect(phaseLabel({ ...base, phase: "done" })).toBe("Paid")
  })
})
