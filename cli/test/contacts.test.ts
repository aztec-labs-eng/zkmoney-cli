import type { Contact } from "../src/frontCore.ts"
import { describe, expect, it } from "vitest"
import { findContact } from "../src/commands/contacts.ts"

describe("findContact", () => {
  const book: Contact[] = [
    { name: "Alice", address: "0x" + "1".repeat(64), tag: "alice" },
    {
      name: "Ledger",
      address: "0x" + "2".repeat(40),
      addressKind: "ethereum-l1",
      l1Wallet: { provider: "manual", provenance: "saved-recipient" },
    },
    {
      name: "Gone",
      address: "0x" + "3".repeat(40),
      addressKind: "ethereum-l1",
      l1Wallet: { provider: "manual", provenance: "saved-recipient", deletedAt: 5 },
    },
  ]

  it("matches any live contact by name, in any case, never a removed one", () => {
    expect(findContact(book, " alice ")?.tag).toBe("alice")
    expect(findContact(book, "LEDGER")?.addressKind).toBe("ethereum-l1")
    expect(findContact(book, "gone")).toBeUndefined()
    expect(findContact(book, "nobody")).toBeUndefined()
  })
})
