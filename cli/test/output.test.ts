import { describe, expect, it } from "vitest"
import { HttpRequestError } from "viem"
import { amount, fields, rpcRefusal, shorten, signed, table } from "../src/output.ts"

describe("output", () => {
  it("formats amounts with grouping and two decimals", () => {
    expect(amount(6017634521863968921818n, 18, "DAI")).toBe("6,017.63 DAI")
    expect(amount(50_000_000n, 6, "USDC")).toBe("50.00 USDC")
    expect(signed(-12_000_000_000_000_000_000n, 18, "DAI")).toBe("-12.00 DAI")
    expect(signed(5n * 10n ** 18n, 18, "DAI")).toBe("+5.00 DAI")
  })

  it("shortens long identifiers unless asked for the full form", () => {
    const addr = "0xdf410ad448A0f7165181FBdB32f8896f4a0d9449"
    expect(shorten(addr)).toBe("0xdf41…9449")
    expect(shorten(addr, true)).toBe(addr)
    expect(shorten("alice")).toBe("alice")
  })

  it("lays out a two-column list and a table with aligned columns", () => {
    expect(
      fields([
        ["Balance", "1.00 DAI"],
        ["Skipped", undefined],
        ["As of", "block 1"],
      ]),
    ).toBe("Balance   1.00 DAI\nAs of     block 1")
    const out = table([
      ["14:02", "receive", "+50.00 DAI"],
      ["Tue", "send", "-1.00 DAI"],
    ])
    expect(out.split("\n")[0]).toBe("14:02  receive  +50.00 DAI")
    expect(out.split("\n")[1]).toBe("Tue    send      -1.00 DAI")
  })
})

describe("rpcRefusal", () => {
  it("reads an RPC's refusal from anywhere in the causes", () => {
    const refusal = new HttpRequestError({
      url: "https://rpc.example/eth",
      status: 403,
      details: JSON.stringify({
        code: -32602,
        message: "Archive requests require a personal token.",
      }),
    })
    const wrapped = new Error("scan failed", { cause: refusal })
    expect(rpcRefusal(wrapped)).toBe(
      "rpc.example refused the request (HTTP 403): Archive requests require a personal token.",
    )
    expect(rpcRefusal(new Error("something else"))).toBeUndefined()
  })
})
