import { PassThrough } from "node:stream"
import { describe, expect, it } from "vitest"
import { RpcError, RpcPeer, fromHex, toHex } from "../src/runtime/upgrade/rpc.ts"

/** Two peers over a pair of pipes, as the host and the generation see each other. */
function pair() {
  const toB = new PassThrough()
  const toA = new PassThrough()
  return { a: new RpcPeer(toA, toB), b: new RpcPeer(toB, toA), toA, toB }
}

describe("RpcPeer", () => {
  it("calls across, and the other side calls back while serving", async () => {
    const { a, b } = pair()
    a.handle("sign", async (params) => ({
      signed: `${(params as { challenge: string }).challenge}!`,
    }))
    b.handle("open", async (params) => {
      const { signed } = (await b.call<{ signed: string }>("sign", { challenge: "0xab" })) ?? {}
      return { opened: (params as { node: string }).node, signed }
    })
    await expect(a.call("open", { node: "n1" })).resolves.toEqual({
      opened: "n1",
      signed: "0xab!",
    })
  })

  it("carries a thrown error back as an RpcError with its message", async () => {
    const { a, b } = pair()
    b.handle("fail", async () => {
      throw new Error("no session is open")
    })
    await expect(a.call("fail")).rejects.toThrow(RpcError)
    await expect(a.call("fail")).rejects.toThrow("no session is open")
    await expect(a.call("missing")).rejects.toThrow("unknown method missing")
  })

  it("interleaves calls by id", async () => {
    const { a, b } = pair()
    const gates: (() => void)[] = []
    b.handle("slow", async (params) => {
      await new Promise<void>((resolve) => gates.push(resolve))
      return params
    })
    const first = a.call("slow", 1)
    const second = a.call("slow", 2)
    gates[1]!()
    await expect(second).resolves.toBe(2)
    gates[0]!()
    await expect(first).resolves.toBe(1)
  })

  it("fails what is waiting when the other side goes away", async () => {
    const { a, b, toA } = pair()
    b.handle("hang", () => new Promise(() => {}))
    const waiting = a.call("hang")
    toA.end()
    await expect(waiting).rejects.toThrow("closed")
    await expect(a.call("hang")).rejects.toThrow("closed")
  })

  it("ignores lines that are not messages", async () => {
    const { a, b, toA } = pair()
    b.handle("ping", async () => "pong")
    toA.write("not json\n\n")
    await expect(a.call("ping")).resolves.toBe("pong")
  })
})

describe("hex", () => {
  it("round-trips bytes and refuses anything else", () => {
    const bytes = new Uint8Array([0, 1, 254, 255])
    expect(toHex(bytes)).toBe("0x0001feff")
    expect([...fromHex("0x0001feff", "x")]).toEqual([...bytes])
    expect(() => fromHex("0001feff", "challenge")).toThrow("challenge is not hex")
    expect(() => fromHex(7, "challenge")).toThrow("challenge is not hex")
  })
})
