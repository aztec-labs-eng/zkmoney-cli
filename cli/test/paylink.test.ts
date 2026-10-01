import { Fr } from "@aztec/aztec.js/fields"
import { DEFAULT_CONTRACTS, PAYLINK_CANCEL_MARGIN_SECONDS } from "@obsidion/core/constants"
import type { PaylinkTransaction } from "../src/frontCore.ts"
import { encodePaylinkInline } from "@obsidion/sdk"
import { describe, expect, it } from "vitest"
import {
  creatorAction,
  isEmailLink,
  linkUrl,
  parseLink,
  walletOrigin,
} from "../src/runtime/paylink.ts"

const fragment = encodePaylinkInline({
  paylinkType: DEFAULT_CONTRACTS.paylinkDirect,
  secret: Fr.random(),
  fallbackKeyHash: Fr.random(),
  classId: Fr.random(),
  chainId: 1,
  rollupVersion: 7,
})

describe("walletOrigin", () => {
  it("picks the web wallet for the network, or the override", () => {
    expect(walletOrigin("mainnet", {})).toBe("https://wallet.zk.money")
    expect(walletOrigin("sandbox", {})).toBe("http://localhost:5173")
    expect(walletOrigin("mainnet", { ZKMONEY_WALLET_URL: "https://my.wallet/" })).toBe(
      "https://my.wallet",
    )
    expect(linkUrl("testnet", "abc")).toBe("https://staging.zk.money/link#abc")
  })
})

describe("parseLink", () => {
  it("takes a full link from any host or the bare fragment", () => {
    const fromUrl = parseLink(`https://elsewhere.example/link#${fragment}`)
    const bare = parseLink(fragment)
    expect(fromUrl.fragment).toBe(fragment)
    expect(bare.params.chainId).toBe(1)
    expect(bare.params.rollupVersion).toBe(7)
    expect(isEmailLink(bare.params)).toBe(false)
  })

  it("refuses text that is not a link", () => {
    expect(() => parseLink("hello")).toThrow(/not a payment link/)
    expect(() => parseLink("https://wallet.zk.money/link#")).toThrow(/not a payment link/)
  })
})

describe("creatorAction", () => {
  const now = 1_000_000
  const row: PaylinkTransaction = {
    action: "Pay To Email",
    emailPaymentAction: "Pay To Email",
    flavor: "direct",
    timestamp: 0,
    status: "success",
    txHash: "0x1",
    paylink: "https://wallet.zk.money/link#x",
    fallbackSecret: "0x2",
    payToEmailSecret: "0x3",
    fromClaimable: now - 100,
    untilClaimable: now + 3_600,
    refundableUntil: now + 3_600,
  }
  const margin = Number(PAYLINK_CANCEL_MARGIN_SECONDS)

  it("offers cancel while a refund can still land inside the window", () => {
    expect(creatorAction(row, now, "awaitingClaim")).toBe("cancel")
    expect(creatorAction(row, now + 3_600 - margin, "awaitingClaim")).toBeUndefined()
  })

  it("offers reclaim once the link expired, and nothing once spent", () => {
    expect(creatorAction(row, now + 3_601, "expired")).toBe("reclaim")
    expect(creatorAction({ ...row, isClaimed: true }, now, "claimed")).toBeUndefined()
    expect(creatorAction({ ...row, isRefunded: true }, now, "refunded")).toBeUndefined()
  })

  it("offers nothing without the refund material", () => {
    expect(creatorAction({ ...row, paylink: undefined }, now, "awaitingClaim")).toBeUndefined()
    expect(creatorAction({ ...row, status: "failed" }, now, "awaitingClaim")).toBeUndefined()
  })
})
