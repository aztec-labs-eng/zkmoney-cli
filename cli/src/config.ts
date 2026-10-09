/**
 * Where the CLI's settings come from, in order: a command flag, an environment variable, the chosen
 * network's settings file, the home's settings file, then the config profile for the network (which
 * carries the node, L1 RPC, account service and oxide manifest for that deployment). The home's file
 * names the network in use; each network's file holds what differs per deployment, such as the
 * node's API key. Every resolved value remembers its source so `config show` can say why the CLI
 * points where it points.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { z } from "zod"
import {
  fetchConfigProfile,
  pinnedProfileUrl,
  resolveVersion,
  toContractServiceConfig,
  type ConfigProfile,
} from "@obsidion/config-client"
import type { ContractServiceConfig, OxideEnvProfile } from "@obsidion/core/types"

const STAGING = "https://cdn.staging.zk.money/profiles/v5/current.json"

/**
 * The profiles the CLI knows by name, the network each runs on, and with `dir` a directory of its own when it shares
 * its network with another profile. `testnet` is staging's other name; dev runs on staging's network.
 */
export const PROFILES: Record<string, { url: string; network: string; dir?: string }> = {
  mainnet: { url: "https://cdn.zk.money/profiles/v5/current.json", network: "mainnet" },
  staging: { url: STAGING, network: "testnet" },
  testnet: { url: STAGING, network: "testnet" },
  dev: { url: "https://cdn.dev.zk.money/profiles/v5/current.json", network: "testnet", dir: "dev" },
  sandbox: { url: "http://localhost:8083/profiles/sandbox.json", network: "sandbox" },
}

/** The settings a user may pin in the file. Anything unset falls through to the profile. */
export const settingsSchema = z
  .object({
    profile: z.string().optional(),
    profileUrl: z.string().url().optional(),
    node: z.object({ url: z.string().url().optional(), apiKey: z.string().optional() }).optional(),
    l1: z.object({ rpc: z.string().url().optional() }).optional(),
    accountService: z.object({ url: z.string().url().optional() }).optional(),
    addresses: z
      .object({
        registry: z.string().optional(),
        portal: z.string().optional(),
        token: z.string().optional(),
        claimFpc: z.string().optional(),
        acrossBridgeEscrowFactory: z.string().optional(),
        cctpBridgeEscrowFactory: z.string().optional(),
      })
      .optional(),
    defaults: z
      .object({
        asset: z.enum(["DAI", "USDC", "USDT"]).optional(),
        withdrawAsset: z.enum(["DAI", "USDC", "USDT", "ETH"]).optional(),
      })
      .optional(),
  })
  .strict()
export type Settings = z.infer<typeof settingsSchema>

export const SETTING_KEYS = [
  "profile",
  "profileUrl",
  "node.url",
  "node.apiKey",
  "l1.rpc",
  "accountService.url",
  "addresses.registry",
  "addresses.portal",
  "addresses.token",
  "addresses.claimFpc",
  "addresses.acrossBridgeEscrowFactory",
  "addresses.cctpBridgeEscrowFactory",
  "defaults.asset",
  "defaults.withdrawAsset",
] as const
export type SettingKey = (typeof SETTING_KEYS)[number]

const ENV_BY_KEY: Record<SettingKey, string> = {
  "profile": "ZKMONEY_PROFILE",
  "profileUrl": "ZKMONEY_PROFILE_URL",
  "node.url": "ZKMONEY_NODE_URL",
  "node.apiKey": "ZKMONEY_NODE_API_KEY",
  "l1.rpc": "ZKMONEY_L1_RPC",
  "accountService.url": "ZKMONEY_ACCOUNT_SERVICE_URL",
  "addresses.registry": "ZKMONEY_REGISTRY",
  "addresses.portal": "ZKMONEY_PORTAL",
  "addresses.token": "ZKMONEY_TOKEN",
  "addresses.claimFpc": "ZKMONEY_CLAIM_FPC",
  "addresses.acrossBridgeEscrowFactory": "ZKMONEY_ACROSS_BRIDGE_ESCROW_FACTORY",
  "addresses.cctpBridgeEscrowFactory": "ZKMONEY_CCTP_BRIDGE_ESCROW_FACTORY",
  "defaults.asset": "ZKMONEY_ASSET",
  "defaults.withdrawAsset": "ZKMONEY_WITHDRAW_ASSET",
}

export function defaultHome(): string {
  const fromEnv = process.env.ZKMONEY_HOME
  if (fromEnv) return fromEnv
  const home = process.env.HOME ?? process.env.USERPROFILE
  if (!home)
    throw new Error("HOME is not set, so there is nowhere to keep the wallet; set ZKMONEY_HOME")
  return join(home, ".zkmoney")
}

/** The home's settings file, or with `dir` that profile directory's own. */
export const settingsPath = (home: string, dir?: string) =>
  dir ? join(home, dir, "config.json") : join(home, "config.json")

export function readSettingsFile(path: string): Settings {
  if (!existsSync(path)) return {}
  const parsed = settingsSchema.safeParse(JSON.parse(readFileSync(path, "utf8")))
  if (!parsed.success) {
    throw new Error(`${path} is not a valid settings file: ${parsed.error.issues[0]?.message}`)
  }
  return parsed.data
}

export function writeSettingsFile(path: string, settings: Settings): void {
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.tmp`
  writeFileSync(tmp, JSON.stringify(settings, null, 2) + "\n")
  renameSync(tmp, path)
}

/** The profile in force: the flag, then ZKMONEY_PROFILE, then the home's settings file. */
export function profileOf(home: string, flag?: string): string {
  return (
    flag ?? process.env.ZKMONEY_PROFILE ?? readSettingsFile(settingsPath(home)).profile ?? "mainnet"
  )
}

/** The network a profile runs on. */
export const networkOf = (profile: string) => PROFILES[profile]?.network ?? profile

/** The directory under the home holding a profile's account, store and settings. */
export const dirOf = (profile: string) => PROFILES[profile]?.dir ?? networkOf(profile)

/** A profile directory's settings over the home's, which apply to every profile. */
export function readSettings(home: string, dir: string): Settings {
  const own = readSettingsFile(settingsPath(home, dir))
  let merged = readSettingsFile(settingsPath(home))
  for (const key of SETTING_KEYS) {
    const value = getSetting(own, key)
    if (value !== undefined) merged = setSetting(merged, key, value)
  }
  return merged
}

export function getSetting(settings: Settings, key: SettingKey): string | undefined {
  const [head, tail] = key.split(".") as [keyof Settings, string | undefined]
  const value = settings[head]
  if (tail === undefined) return value as string | undefined
  return (value as Record<string, string> | undefined)?.[tail]
}

export function setSetting(
  settings: Settings,
  key: SettingKey,
  value: string | undefined,
): Settings {
  const next: Record<string, unknown> = { ...settings }
  const [head, tail] = key.split(".") as [string, string | undefined]
  if (tail === undefined) {
    if (value === undefined) delete next[head]
    else next[head] = value
  } else {
    const group = { ...((next[head] as Record<string, unknown> | undefined) ?? {}) }
    if (value === undefined) delete group[tail]
    else group[tail] = value
    if (Object.keys(group).length) next[head] = group
    else delete next[head]
  }
  const parsed = settingsSchema.safeParse(next)
  if (!parsed.success) throw new Error(`${key}: ${parsed.error.issues[0]?.message}`)
  return parsed.data
}

export type Source = "flag" | "env" | "file" | "profile" | "default"
export interface Resolved<T> {
  value: T
  source: Source
}

export interface Flags {
  home?: string
  profile?: string
  profileUrl?: string
  nodeUrl?: string
  l1Rpc?: string
}

export interface CliConfig {
  home: string
  network: string
  /** Where under `home` this profile's account, store and settings live. */
  dir: string
  profileId: string
  /** The profile version in force, and the pin of its reviewed contract artifacts. */
  versionId: string
  artifactManifestSha256: string | undefined
  profileUrl: Resolved<string>
  nodeUrl: Resolved<string>
  nodeApiKey: string | undefined
  l1RpcUrl: Resolved<string>
  l1ChainId: number
  accountServiceUrl: Resolved<string | undefined>
  snapshot: ContractServiceConfig
  oxide: OxideEnvProfile
  claimFpcAddress: Resolved<string | undefined>
  /** The bridge escrow factories set here; each overrides the manifest's. */
  bridgeEscrowFactories: { across?: Resolved<string>; cctp?: Resolved<string> }
  addressOverrides: { registry?: string; portal?: string; token?: string }
  defaults: { asset: string; withdrawAsset: string }
  settings: Settings
  profile: ConfigProfile
}

function pick(
  key: SettingKey,
  flag: string | undefined,
  settings: Settings,
): { value: string; source: Source } | undefined {
  if (flag) return { value: flag, source: "flag" }
  const env = process.env[ENV_BY_KEY[key]]
  if (env) return { value: env, source: "env" }
  const file = getSetting(settings, key)
  if (file) return { value: file, source: "file" }
  return undefined
}

/**
 * Resolve everything a command needs. The profile is fetched once per call; commands that only
 * touch local state (`config`, `account show`) use `readSettings` directly and never fetch.
 */
export async function loadConfig(flags: Flags = {}, fetchImpl?: typeof fetch): Promise<CliConfig> {
  const home = flags.home ?? defaultHome()
  const profileName = profileOf(home, flags.profile)
  const network = networkOf(profileName)
  const dir = dirOf(profileName)
  const settings = readSettings(home, dir)
  const profileUrl =
    pick("profileUrl", flags.profileUrl, settings) ??
    (PROFILES[profileName]
      ? { value: PROFILES[profileName].url, source: "default" as const }
      : undefined)
  if (!profileUrl) {
    throw new Error(
      `no config profile is known for "${profileName}"; set profileUrl to its profile document`,
    )
  }
  const versionId = process.env.ZKMONEY_PROFILE_VERSION
  const profile = await fetchConfigProfile(pinnedProfileUrl(profileUrl.value, versionId), {
    fetchImpl,
  })
  if (profile.network !== network) {
    throw new Error(`profile at ${profileUrl.value} is for "${profile.network}", not "${network}"`)
  }
  const { version, versionId: resolvedVersionId } = resolveVersion(profile, versionId)
  const snapshot = toContractServiceConfig(profile, versionId)
  const nodeUrl = pick("node.url", flags.nodeUrl, settings) ?? {
    value: version.nodeUrl,
    source: "profile" as const,
  }
  const l1RpcUrl = pick("l1.rpc", flags.l1Rpc, settings) ?? {
    value: version.l1RpcUrl,
    source: "profile" as const,
  }
  const accountServiceUrl =
    pick("accountService.url", undefined, settings) ??
    ({ value: version.accountServiceUrl, source: "profile" } as Resolved<string | undefined>)
  const claimFpcOverride = pick("addresses.claimFpc", undefined, settings)
  const claimFpcAddress: Resolved<string | undefined> = claimFpcOverride ?? {
    value: snapshot.contracts.claimFpc?.address,
    source: "profile",
  }
  return {
    home,
    network,
    dir,
    profileId: profile.profileId,
    versionId: resolvedVersionId,
    artifactManifestSha256: version.artifactManifestSha256,
    profileUrl,
    nodeUrl,
    nodeApiKey: pick("node.apiKey", undefined, settings)?.value,
    l1RpcUrl,
    l1ChainId: profile.shared.l1ChainId,
    accountServiceUrl,
    snapshot,
    oxide: version.oxide,
    claimFpcAddress,
    bridgeEscrowFactories: {
      across: pick("addresses.acrossBridgeEscrowFactory", undefined, settings),
      cctp: pick("addresses.cctpBridgeEscrowFactory", undefined, settings),
    },
    addressOverrides: {
      registry: pick("addresses.registry", undefined, settings)?.value,
      portal: pick("addresses.portal", undefined, settings)?.value,
      token: pick("addresses.token", undefined, settings)?.value,
    },
    defaults: {
      asset: pick("defaults.asset", undefined, settings)?.value ?? "DAI",
      withdrawAsset: pick("defaults.withdrawAsset", undefined, settings)?.value ?? "DAI",
    },
    settings,
    profile,
  }
}

/** Every setting with the value in force and where it came from, for `config show`. */
export function describeSettings(
  settings: Settings,
  profileFlag?: string,
): { key: SettingKey; value: string | undefined; source: Source }[] {
  return SETTING_KEYS.map((key) => {
    if (key === "profile" && profileFlag) return { key, value: profileFlag, source: "flag" }
    const env = process.env[ENV_BY_KEY[key]]
    if (env) return { key, value: env, source: "env" }
    const file = getSetting(settings, key)
    if (file) return { key, value: file, source: "file" }
    return { key, value: undefined, source: "profile" }
  })
}

export const envVarFor = (key: SettingKey) => ENV_BY_KEY[key]
