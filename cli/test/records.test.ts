import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { Records } from "../src/runtime/records.ts"
import { FileStorageAdapter } from "../src/storage.ts"

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})
const records = () => {
  const dir = mkdtempSync(join(tmpdir(), "zkmoney-rec-"))
  dirs.push(dir)
  return new Records(new FileStorageAdapter(join(dir, "store.json")))
}

describe("idempotency records", () => {
  it("runs once per key and replays the result", async () => {
    const r = records()
    let runs = 0
    const act = async () => ({ txHash: `0x${++runs}` })
    const first = await r.once("send", "req-1", { to: "alice", amount: "5" }, act)
    const second = await r.once("send", "req-1", { to: "alice", amount: "5" }, act)
    expect(first).toEqual({ result: { txHash: "0x1" }, replayed: false })
    expect(second).toEqual({ result: { txHash: "0x1" }, replayed: true })
    expect(runs).toBe(1)
  })

  it("refuses a key reused with different arguments", async () => {
    const r = records()
    await r.once("send", "req-2", { to: "alice", amount: "5" }, async () => "ok")
    await expect(
      r.once("send", "req-2", { to: "bob", amount: "5" }, async () => "ok"),
    ).rejects.toThrow(/already used/)
  })

  it("keeps the failure and retries a key whose act threw", async () => {
    const r = records()
    await expect(
      r.once("send", "req-3", {}, async () => {
        throw new Error("node down")
      }),
    ).rejects.toThrow("node down")
    expect((await r.get("send", "req-3"))?.error).toBe("node down")
    const again = await r.once("send", "req-3", {}, async () => "done")
    expect(again).toEqual({ result: "done", replayed: false })
    expect((await r.list("send")).map((x) => x.key)).toEqual(["req-3"])
  })
})
