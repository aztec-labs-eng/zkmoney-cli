import { describe, expect, it } from "vitest"
import type { IStorageAdapter } from "../src/frontCore.ts"
import {
  DepositSlots,
  depositScope,
  readAllSlots,
  type DepositSlot,
} from "../src/runtime/depositSlots.ts"

class MemoryStorage implements IStorageAdapter {
  map = new Map<string, string>()
  async getItem(key: string) {
    return this.map.get(key) ?? null
  }
  async setItem(key: string, value: string) {
    this.map.set(key, value)
  }
  async removeItem(key: string) {
    this.map.delete(key)
  }
  async clear() {
    this.map.clear()
  }
  keys() {
    return [...this.map.keys()]
  }
}

const slot = (n: number, published: boolean): DepositSlot => ({
  address: `0x${n.toString(16).padStart(40, "a")}`,
  day: 20_000,
  nonce: 999_999 - n,
  published,
  createdAt: n,
})

describe("DepositSlots", () => {
  it("scopes by network, portal and account, case-insensitively", () => {
    expect(depositScope("mainnet", "0xABC", "0xDEF")).toBe("mainnet/0xabc/0xdef")
  })

  it("lists newest first and finishes the oldest unpublished slot first", async () => {
    const slots = new DepositSlots(new MemoryStorage(), "s")
    await slots.put(slot(1, false))
    await slots.put(slot(2, true))
    await slots.put(slot(3, false))
    expect((await slots.list()).map((s) => s.createdAt)).toEqual([3, 2, 1])
    expect((await slots.unpublished()).map((s) => s.createdAt)).toEqual([1, 3])
    expect((await slots.get(slot(2, true).address.toUpperCase()))?.published).toBe(true)
  })

  it("hands out slots in order, saving the counter before use", async () => {
    const storage = new MemoryStorage()
    const slots = new DepositSlots(storage, "s")
    expect(await slots.takeSlot(1)).toBe(0)
    expect(await slots.takeSlot(1)).toBe(1)
    expect(await new DepositSlots(storage, "s").takeSlot(1)).toBe(2)
  })

  it("lets the chain's floor win over the local counter, and resets when the day rolls", async () => {
    const slots = new DepositSlots(new MemoryStorage(), "s")
    expect(await slots.takeSlot(1, 4)).toBe(4)
    expect(await slots.takeSlot(1, 2)).toBe(5)
    expect(await slots.takeSlot(2)).toBe(0)
  })

  it("survives a corrupt counter", async () => {
    const storage = new MemoryStorage()
    storage.map.set("zkmoney.sipa/v1/s/next", "{not json")
    expect(await new DepositSlots(storage, "s").takeSlot(1, 3)).toBe(3)
  })

  it("reads every slot across scopes by address for account-free reads", async () => {
    const storage = new MemoryStorage()
    await new DepositSlots(storage, "a").put(slot(1, true))
    await new DepositSlots(storage, "b").put(slot(2, false))
    const all = await readAllSlots(storage)
    expect([...all.keys()].sort()).toEqual([slot(1, true).address, slot(2, false).address].sort())
    expect(all.get(slot(2, false).address)?.published).toBe(false)
  })
})
