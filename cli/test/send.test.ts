import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { TxExecutionResult, TxStatus } from "@aztec/stdlib/tx"
import type { Contact } from "../src/frontCore.ts"
import { afterEach, describe, expect, it } from "vitest"
import { CliError } from "../src/output.ts"
import { Records } from "../src/runtime/records.ts"
import {
  PAYMENT_KIND,
  assertSendAsset,
  matchContact,
  parseSendAmount,
  paymentStatus,
  receiptOutcome,
  refuseInterrupted,
  type PaymentRecord,
} from "../src/runtime/send.ts"
import { FileStorageAdapter } from "../src/storage.ts"

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})
const records = () => {
  const dir = mkdtempSync(join(tmpdir(), "zkmoney-send-"))
  dirs.push(dir)
  return new Records(new FileStorageAdapter(join(dir, "store.json")))
}

describe("parseSendAmount", () => {
  it("takes dollars with up to two decimals, folding a comma separator", () => {
    expect(parseSendAmount("12.50", 18)).toEqual({
      atomic: 12_500_000_000_000_000_000n,
      text: "12.50",
    })
    expect(parseSendAmount("5,25", 18).atomic).toBe(5_250_000_000_000_000_000n)
    expect(parseSendAmount(" 3 ", 6).atomic).toBe(3_000_000n)
  })

  it("refuses what is not an amount", () => {
    for (const bad of ["0", "-1", "1.234", "1e3", "abc", ""]) {
      expect(() => parseSendAmount(bad, 18)).toThrow(CliError)
    }
  })
})

describe("assertSendAsset", () => {
  it("accepts the L2 asset by any case and no asset at all", () => {
    expect(() => assertSendAsset("mainnet", undefined, "DAI")).not.toThrow()
    expect(() => assertSendAsset("mainnet", "dai", "DAI")).not.toThrow()
  })

  it("refuses another asset, saying why on mainnet", () => {
    let caught: unknown
    try {
      assertSendAsset("mainnet", "USDC", "DAI")
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(CliError)
    expect((caught as CliError).message).toContain("USDC")
    expect((caught as CliError).hint).toContain("only L2 asset is DAI")
    expect(() => assertSendAsset("sandbox", "USDC", "DAI")).toThrow(/cannot send USDC/)
  })
})

describe("matchContact", () => {
  const book: Contact[] = [
    { name: "Alice", address: "0x" + "1".repeat(64), tag: "alice", addressKind: "aztec-l2" },
    { name: "Bob", address: "0x" + "2".repeat(64) },
    {
      name: "Carol",
      address: "0x" + "3".repeat(40),
      addressKind: "ethereum-l1",
      l1Wallet: { provider: "manual", provenance: "saved-recipient" },
    },
  ]

  it("finds an L2 contact by name or tag, in any case", () => {
    expect(matchContact(book, "alice")?.name).toBe("Alice")
    expect(matchContact(book, "@Alice")?.name).toBe("Alice")
    expect(matchContact(book, "bob")?.name).toBe("Bob")
  })

  it("ignores Ethereum contacts and strangers", () => {
    expect(matchContact(book, "carol")).toBeUndefined()
    expect(matchContact(book, "dave")).toBeUndefined()
  })
})

describe("receiptOutcome", () => {
  it("names the four outcomes", () => {
    expect(receiptOutcome({ status: TxStatus.PENDING })).toBe("pending")
    expect(receiptOutcome({ status: TxStatus.DROPPED })).toBe("dropped")
    expect(
      receiptOutcome({ status: TxStatus.PROVEN, executionResult: TxExecutionResult.SUCCESS }),
    ).toBe("mined")
    expect(
      receiptOutcome({ status: TxStatus.PROPOSED, executionResult: TxExecutionResult.REVERTED }),
    ).toBe("failed")
  })
})

describe("paymentStatus", () => {
  const base: Omit<PaymentRecord, "outcome" | "txHash"> = {
    operationId: "send_1",
    to: "0x" + "1".repeat(64),
    label: "@alice",
    amountAtomic: "1",
    symbol: "DAI",
    decimals: 18,
  }
  const hash = "0x" + "0a".repeat(32)

  it("asks the node when the payment has a hash", async () => {
    const node = { getTxReceipt: async () => ({ status: TxStatus.PENDING }) }
    const record = {
      kind: PAYMENT_KIND,
      key: "k",
      args: "{}",
      createdAt: 0,
      result: { ...base, txHash: hash, outcome: "mined" as const },
    }
    expect(await paymentStatus({ node } as never, record)).toEqual({ status: "pending" })
  })

  it("falls back to the record when the node cannot answer", async () => {
    const node = {
      getTxReceipt: async () => {
        throw new Error("down")
      },
    }
    const record = {
      kind: PAYMENT_KIND,
      key: "k",
      args: "{}",
      createdAt: 0,
      result: { ...base, txHash: hash, outcome: "submitted" as const },
    }
    expect(await paymentStatus({ node } as never, record)).toEqual({ status: "pending" })
    expect(
      await paymentStatus(undefined, { ...record, result: { ...record.result, outcome: "mined" } }),
    ).toEqual({
      status: "mined",
    })
  })

  it("reads a hashless record as failed or interrupted", async () => {
    const record = { kind: PAYMENT_KIND, key: "k", args: "{}", createdAt: 0 }
    expect(await paymentStatus(undefined, { ...record, error: "no funds" })).toEqual({
      status: "failed",
      detail: "no funds",
    })
    expect((await paymentStatus(undefined, record)).status).toBe("interrupted")
  })
})

describe("refuseInterrupted", () => {
  it("refuses a key whose attempt neither finished nor failed", async () => {
    const r = records()
    await r.put({ kind: PAYMENT_KIND, key: "cut", args: "{}", createdAt: 0 })
    await expect(refuseInterrupted(r, PAYMENT_KIND, "cut", "hint")).rejects.toThrow(/interrupted/)
  })

  it("lets a finished, a failed or an unknown key through", async () => {
    const r = records()
    await r.put({ kind: PAYMENT_KIND, key: "done", args: "{}", createdAt: 0, result: { ok: 1 } })
    await r.put({ kind: PAYMENT_KIND, key: "bad", args: "{}", createdAt: 0, error: "nope" })
    for (const key of ["done", "bad", "new"]) {
      await expect(refuseInterrupted(r, PAYMENT_KIND, key, "hint")).resolves.toBeUndefined()
    }
  })
})
