import { describe, expect, it } from "vitest"
import { apyFromSsr } from "../src/runtime/savings.ts"

describe("apyFromSsr", () => {
  it("reads Sky's per-second savings rate as the yearly yield it compounds to", () => {
    expect(apyFromSsr(1000000001395766281313196627n)).toBeCloseTo(0.045, 6)
    expect(apyFromSsr(10n ** 27n)).toBe(0)
  })
})
