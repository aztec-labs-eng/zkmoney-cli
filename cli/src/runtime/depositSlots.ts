/**
 * The deposit addresses this CLI derived, each by the `(day, nonce)` that regenerates it. A slot is
 * saved before its address is shown and marked published once its broadcast landed, so an address
 * whose broadcast failed is finished on the next `deposits create` instead of being abandoned with
 * whatever a depositor already sent to it. Scoped to the deployment and the account: a portal roll
 * or another account must never reuse a slot.
 */
import type { Address } from "viem"
import type { IStorageAdapter } from "../frontCore.ts"

const PREFIX = "zkmoney.sipa/v1/"

export interface DepositSlot {
  address: Address
  day: number
  nonce: number
  published: boolean
  /** The broadcast reached the node under this hash; the chain decides whether it landed. */
  broadcastTxHash?: string
  /** What the user asked the depositor for. Display only; nothing on chain enforces it. */
  request?: { asset: string; amount?: string }
  createdAt: number
}

export interface SlotStorage extends IStorageAdapter {
  keys(): string[]
}

export const depositScope = (network: string, portal: string, account: string): string =>
  `${network}/${portal.toLowerCase()}/${account.toLowerCase()}`

/** Every slot in the store, whatever its scope, by lowercase address. For reads that never unlock the account. */
export async function readAllSlots(storage: SlotStorage): Promise<Map<string, DepositSlot>> {
  const out = new Map<string, DepositSlot>()
  for (const key of storage.keys()) {
    if (!key.startsWith(PREFIX) || !key.includes("/slot/")) continue
    const raw = await storage.getItem(key)
    if (!raw) continue
    const slot = JSON.parse(raw) as DepositSlot
    out.set(slot.address.toLowerCase(), slot)
  }
  return out
}

export class DepositSlots {
  constructor(
    private readonly storage: SlotStorage,
    private readonly scope: string,
  ) {}

  private slotKey(address: string): string {
    return `${PREFIX}${this.scope}/slot/${address.toLowerCase()}`
  }

  async get(address: string): Promise<DepositSlot | undefined> {
    const raw = await this.storage.getItem(this.slotKey(address))
    return raw ? (JSON.parse(raw) as DepositSlot) : undefined
  }

  async put(slot: DepositSlot): Promise<void> {
    await this.storage.setItem(this.slotKey(slot.address), JSON.stringify(slot))
  }

  /** Every slot in this scope, newest first. */
  async list(): Promise<DepositSlot[]> {
    const prefix = `${PREFIX}${this.scope}/slot/`
    const out: DepositSlot[] = []
    for (const key of this.storage.keys()) {
      if (!key.startsWith(prefix)) continue
      const raw = await this.storage.getItem(key)
      if (raw) out.push(JSON.parse(raw) as DepositSlot)
    }
    return out.sort((a, b) => b.createdAt - a.createdAt)
  }

  /** Slots handed out but never broadcast, oldest first. */
  async unpublished(): Promise<DepositSlot[]> {
    return (await this.list()).filter((s) => !s.published).reverse()
  }

  /**
   * The next self-resolution slot for `day`. The local counter covers what this store derived,
   * `floor` what the chain already shows broadcast today, and the higher wins. Saved before it is
   * used, so a crash never hands the same slot out twice.
   */
  async takeSlot(day: number, floor = 0): Promise<number> {
    const key = `${PREFIX}${this.scope}/next`
    let slot = Math.max(0, floor)
    try {
      const stored = JSON.parse((await this.storage.getItem(key)) ?? "null") as {
        day?: number
        next?: number
      } | null
      if (stored?.day === day && Number.isInteger(stored.next)) slot = Math.max(slot, stored.next!)
    } catch {
      // A corrupt counter still leaves the chain's floor.
    }
    await this.storage.setItem(key, JSON.stringify({ day, next: slot + 1 }))
    return slot
  }
}
