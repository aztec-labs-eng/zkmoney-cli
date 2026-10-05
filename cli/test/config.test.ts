import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import {
  describeSettings,
  dirOf,
  getSetting,
  loadConfig,
  networkOf,
  profileOf,
  readSettings,
  readSettingsFile,
  setSetting,
  settingsPath,
  writeSettingsFile,
} from "../src/config.ts"

const dirs: string[] = []
const home = () => {
  const dir = mkdtempSync(join(tmpdir(), "zkmoney-cfg-"))
  dirs.push(dir)
  return dir
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
  delete process.env.ZKMONEY_NODE_URL
  delete process.env.ZKMONEY_PROFILE
})

describe("settings", () => {
  it("round-trips nested keys through a network's file", () => {
    const dir = home()
    const path = settingsPath(dir, "mainnet")
    let s = setSetting(readSettingsFile(path), "node.url", "https://node.example/rpc")
    s = setSetting(s, "addresses.registry", "0xa9863b8f573d62377d987ccb9af6e0000f99d14a")
    writeSettingsFile(path, s)
    const back = readSettings(dir, "mainnet")
    expect(getSetting(back, "node.url")).toBe("https://node.example/rpc")
    expect(getSetting(back, "addresses.registry")).toBe(
      "0xa9863b8f573d62377d987ccb9af6e0000f99d14a",
    )
    const cleared = setSetting(back, "node.url", undefined)
    expect(getSetting(cleared, "node.url")).toBeUndefined()
    expect(cleared.node).toBeUndefined()
  })

  it("keeps each network's node key apart, over values the home file gives every network", () => {
    const dir = home()
    writeSettingsFile(settingsPath(dir), { profile: "staging", l1: { rpc: "https://l1.example/" } })
    writeSettingsFile(settingsPath(dir, "mainnet"), { node: { apiKey: "mainnet-key" } })
    writeSettingsFile(settingsPath(dir, "testnet"), { node: { apiKey: "staging-key" } })
    expect(getSetting(readSettings(dir, "mainnet"), "node.apiKey")).toBe("mainnet-key")
    expect(getSetting(readSettings(dir, "testnet"), "node.apiKey")).toBe("staging-key")
    expect(getSetting(readSettings(dir, "mainnet"), "l1.rpc")).toBe("https://l1.example/")
    writeSettingsFile(settingsPath(dir, "mainnet"), { l1: { rpc: "https://own.example/" } })
    expect(getSetting(readSettings(dir, "mainnet"), "l1.rpc")).toBe("https://own.example/")
  })

  it("picks the profile from the flag, then the environment, then the home file", () => {
    const dir = home()
    expect(profileOf(dir)).toBe("mainnet")
    writeSettingsFile(settingsPath(dir), { profile: "staging" })
    expect(profileOf(dir)).toBe("staging")
    process.env.ZKMONEY_PROFILE = "sandbox"
    expect(profileOf(dir)).toBe("sandbox")
    expect(profileOf(dir, "mainnet")).toBe("mainnet")
  })

  it("runs staging and testnet on the one testnet network", () => {
    expect(networkOf("staging")).toBe("testnet")
    expect(networkOf("testnet")).toBe("testnet")
    expect(networkOf("mainnet")).toBe("mainnet")
    expect(networkOf("custom")).toBe("custom")
  })

  it("runs dev on the testnet network, in a directory of its own", () => {
    expect(networkOf("dev")).toBe("testnet")
    expect([dirOf("dev"), dirOf("staging"), dirOf("custom")]).toEqual(["dev", "testnet", "custom"])
  })

  it("rejects a value the schema refuses", () => {
    expect(() => setSetting({}, "node.url", "not a url")).toThrow(/node.url/)
    expect(() => setSetting({}, "defaults.asset", "BTC")).toThrow(/defaults.asset/)
  })

  it("reports the source of each value, flag and env over file", () => {
    process.env.ZKMONEY_NODE_URL = "https://env.example/rpc"
    const s = setSetting({}, "node.url", "https://file.example/rpc")
    const row = describeSettings(s).find((r) => r.key === "node.url")
    expect(row).toEqual({ key: "node.url", value: "https://env.example/rpc", source: "env" })
    delete process.env.ZKMONEY_NODE_URL
    expect(describeSettings(s).find((r) => r.key === "node.url")?.source).toBe("file")
    expect(describeSettings({}).find((r) => r.key === "node.url")?.source).toBe("profile")
    expect(describeSettings({}, "staging").find((r) => r.key === "profile")).toEqual({
      key: "profile",
      value: "staging",
      source: "flag",
    })
  })
})

describe("assets", () => {
  const SKY_PORTAL = "0x00000000000000000000000000000000000000aa"
  const DAI = { portal: "0x00000000000000000000000000000000000000bb" }
  const doc = (sUSDS?: object) => ({
    profileId: "staging-v5",
    network: "testnet",
    publishedAt: "2026-10-05T00:00:00Z",
    shared: { l1ChainId: 11155111, xmtpEnv: "dev", rollupVersion: "1821665230" },
    current: "0.1.0",
    versions: {
      "0.1.0": {
        schemaVersion: "1",
        deployedAt: "2026-10-05T00:00:00Z",
        nodeUrl: "https://node.example",
        l1RpcUrl: "https://l1.example",
        accountServiceUrl: "https://account.example",
        zkmoneyApiUrl: "https://api.example",
        paylinkDomain: "https://paylink.example",
        oxide: { manifestUrl: "https://manifest.example/staging.v4.json", ...DAI },
        assets: { DAI, ...(sUSDS ? { sUSDS } : {}) },
        contracts: {
          sponsorFPC: { address: "0x" + "1".repeat(64), classId: "0x" + "2".repeat(64) },
        },
      },
    },
  })
  const serve =
    (body: unknown): typeof fetch =>
    async () =>
      new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } })
  const load = (dir: string, body: unknown) =>
    loadConfig({ home: dir, profile: "staging" }, serve(body))

  it("come from the network's profile, and a settings override wins for sUSDS", async () => {
    const dir = home()
    expect((await load(dir, doc({ portal: SKY_PORTAL }))).assets).toEqual({
      DAI: { value: DAI, source: "profile" },
      sUSDS: { value: { portal: SKY_PORTAL }, source: "profile" },
    })
    expect((await load(dir, doc())).assets.sUSDS).toBeUndefined()

    writeSettingsFile(settingsPath(dir, "testnet"), setSetting({}, "addresses.sUSDSPortal", "0xcc"))
    expect((await load(dir, doc({ portal: SKY_PORTAL }))).assets.sUSDS).toEqual({
      value: { portal: "0xcc" },
      source: "file",
    })
  })

  it("keep an asset's own manifest, which a portal override does not move", async () => {
    const dir = home()
    const own = { portal: SKY_PORTAL, manifestUrl: "https://manifest.example/relayed-bridges.json" }
    expect((await load(dir, doc(own))).assets.sUSDS).toEqual({ value: own, source: "profile" })

    writeSettingsFile(settingsPath(dir, "testnet"), setSetting({}, "addresses.sUSDSPortal", "0xcc"))
    expect((await load(dir, doc(own))).assets.sUSDS).toEqual({
      value: { portal: "0xcc", manifestUrl: own.manifestUrl },
      source: "file",
    })
  })
})
