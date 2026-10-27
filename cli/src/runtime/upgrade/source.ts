/**
 * The old network an upgrade moves from: the profile the active one names as its previous
 * generation, that profile's oxide deployment, the node that still serves its rollup, and what this
 * CLI kept for it. One generation back is read: the v5 rollup the v6 cutover retired.
 */
import { existsSync } from "node:fs"
import { join } from "node:path"
import type { Fr } from "@aztec-labs/aztec.js/fields"
import {
  fetchConfigProfile,
  resolveVersion,
  toContractServiceConfig,
  type ConfigProfile,
  type ConfigVersion,
} from "@obsidion/config-client"
import { loadOxideManifestTuple } from "@obsidion/core/oxide"
import type {
  ContractServiceConfig,
  FrozenDepositDescriptor,
  OxideEnvTuple,
  SourceArtifactManifest,
  SourceSipaScan,
} from "@obsidion/core/types"
import {
  fetchHistoricalSipaResolverOperators,
  predictAccountAddress,
  resolverSelectionPolicy,
} from "@obsidion/sdk"
import type { Address } from "viem"
import {
  TransactionStorage,
  deploymentScanRange,
  deriveBootstrapKey,
  deriveStealthKey,
  refundableSavingsDeposits,
  scanSweptDeposits,
  type IStorageAdapter,
  type Transaction,
} from "../../frontCore.ts"
import { fail } from "../../output.ts"
import { FileStorageAdapter } from "../../storage.ts"
import type { Runtime } from "../boot.ts"
import type { GenerationSession } from "./generation.ts"

export interface UpgradeSource {
  profileUrl: string
  profile: ConfigProfile
  versionId: string
  version: ConfigVersion
  tuple: OxideEnvTuple
  /** A node that still serves the old rollup, with all its historical state. */
  nodeUrl: string
  nodeApiKey?: string
  contracts: ContractServiceConfig
  artifacts: SourceArtifactManifest
  /** This CLI's directory for the old network: its PXE and records, as the v5 CLI laid them out. */
  dir: string
}

export async function previousGeneration(
  rt: Pick<Runtime, "config" | "network">,
): Promise<UpgradeSource> {
  const url = rt.config.profile.shared.previousGenerationProfile
  if (!url)
    fail(
      `the ${rt.config.profileId} profile names no previous generation`,
      "there is no old network to upgrade from",
    )
  const profile = await fetchConfigProfile(url)
  if (profile.network !== rt.network)
    fail(`the previous profile at ${url} is for "${profile.network}", not "${rt.network}"`)
  const { version, versionId } = resolveVersion(profile)
  const tuple = await loadOxideManifestTuple({
    manifestUrl: version.oxide.manifestUrl,
    portal: version.oxide.portal,
    network: rt.network,
    expectedGitSha: version.oxide.expectedGitSha,
  })
  return {
    profileUrl: url,
    profile,
    versionId,
    version,
    tuple,
    nodeUrl: rt.config.sourceNode.url ?? version.nodeUrl,
    nodeApiKey: rt.config.sourceNode.apiKey ?? rt.config.nodeApiKey,
    contracts: toContractServiceConfig(profile, versionId),
    artifacts: {
      profileUrl: url,
      profileId: profile.profileId,
      versionId,
      expectedSha256: version.artifactManifestSha256,
    },
    dir: join(rt.config.home, rt.config.dir),
  }
}

/** What the generation needs to find the old deployment's SIPAs, in plain data. */
export async function sourceSipaScanParams(
  rt: Pick<Runtime, "l1" | "network">,
  source: UpgradeSource,
  masterSecret: Fr,
  scanHead: bigint,
): Promise<SourceSipaScan> {
  const { tuple } = source
  if (!tuple.accountMetadataRegistry) fail("the old deployment has no resolver registry")
  const stealthPublicKey = deriveStealthKey(masterSecret).publicKey
  const senders = (
    await fetchHistoricalSipaResolverOperators(
      rt.l1 as never,
      tuple.accountMetadataRegistry as Address,
      await deploymentScanRange(rt.l1, tuple, scanHead),
      {
        forwardingTable: tuple.forwardingTable ?? tuple.portal,
        resolverGatewayUrl: tuple.resolverGatewayUrl,
        ...resolverSelectionPolicy(rt.network),
      },
    )
  ).map((record) => record.l2Address)
  const recoveryAccount =
    tuple.sipaRecoveryProtocol === "account" && tuple.accountFactory
      ? await predictAccountAddress(
          rt.l1 as never,
          tuple.accountFactory as Address,
          deriveBootstrapKey(masterSecret).address,
        )
      : undefined
  return {
    tuple,
    resolverL2Addresses: senders,
    stealthPublicKey: { x: stealthPublicKey.x.toString(), y: stealthPublicKey.y.toString() },
    recoveryAccount,
  }
}

/**
 * The old deployment's deposits a frozen refund can return: the swept deposits of the account's
 * SIPAs, found from the old rollup's `SIPA` events and the L1 logs, and the deposits of its Savings
 * moves. One L1 head bounds the whole read.
 */
export async function sourceDepositDescriptors(
  rt: Pick<Runtime, "l1" | "network">,
  source: UpgradeSource,
  session: GenerationSession,
  masterSecret: Fr,
): Promise<FrozenDepositDescriptor[]> {
  const { tuple } = source
  const scanHead = await rt.l1.getBlockNumber({ cacheTime: 0 })
  const sources =
    tuple.depositSIPAImplementation || tuple.registrationSIPAImplementation
      ? (
          await session.sipaSources(await sourceSipaScanParams(rt, source, masterSecret, scanHead))
        ).map((found) => ({ ...found, origin: "sipa-event" as const }))
      : []
  const range = await deploymentScanRange(rt.l1, tuple, scanHead)
  const window = { fromBlock: range.fromBlock, head: range.toBlock }
  const { descriptors } = await scanSweptDeposits(
    {
      publicClient: rt.l1,
      portal: tuple.portal as Address,
      token: tuple.token as Address,
      ...window,
    },
    sources,
  )
  const savings = await refundableSavingsDeposits({
    publicClient: rt.l1,
    portal: tuple.portal as Address,
    recipient: session.address,
    masterSecret,
    moves: await session.savingsMoves({ tuple }),
    ...window,
  })
  return [...new Map([...descriptors, ...savings].map((d) => [d.messageKey, d])).values()]
}

/** The transaction rows the v5 CLI kept for the old network; a link no transfer announces is rebuilt from its row. */
export async function sourceLinkRows(source: UpgradeSource): Promise<Transaction[]> {
  const path = join(source.dir, "store.json")
  if (!existsSync(path)) return []
  // The store is a singleton over the active storage; the old network's file gets its own instance.
  const store = new (TransactionStorage as unknown as new (
    s: IStorageAdapter,
  ) => TransactionStorage)(new FileStorageAdapter(path))
  return (await store.getTransactions()) ?? []
}
