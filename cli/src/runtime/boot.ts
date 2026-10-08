/**
 * One process, one wallet: the Aztec node client, a PXE over an on-disk store, the ObsidionWallet
 * on top, the ContractService fed by the config profile, and the oxide environment read from the
 * manifest. Commands that sign also unlock the account and build the TokenService.
 */
import { join } from "node:path"
import { createPXE, getPXEConfig } from "@aztec/pxe/server"
import type { PXE } from "@aztec/pxe/server"
import type { AztecNode } from "@aztec/aztec.js/node"
import { createPublicClient, http, type Chain, type Hex, type PublicClient } from "viem"
import { foundry, mainnet, sepolia } from "viem/chains"
import { loadOxideManifestTuple } from "@obsidion/core/oxide"
import { isAllZeroHex } from "@obsidion/core/oxide"
import type { OxideEnvTuple } from "@obsidion/core/types"
import {
  ContractService,
  NodeContractServiceStorage,
  createClassArtifactResolver,
  getBroadcasterArtifact,
  resolveInstanceArtifact,
  ObsidionWallet,
  TokenService,
  createNode,
  type Network,
  type ObsidionAccount,
} from "@obsidion/sdk"
import {
  createOxideTeeSignerSource,
  oxideEnvFromTuple,
  resolveOxideAccountFactory,
  type OxideRegistrationEnv,
} from "../frontCore.ts"
import { createArtifactPinResolver } from "@obsidion/config-client"
import type { ContractArtifact } from "@aztec/stdlib/abi"
import { AztecAddress } from "@aztec/stdlib/aztec-address"
import { loadConfig, type CliConfig, type Flags } from "../config.ts"
import { providerFor } from "../keystore/authenticator.ts"
import { rememberIdentity, unlockAccount, type UnlockedAccount } from "../keystore/keystore.ts"
import { FileStorageAdapter } from "../storage.ts"
import { resolverOperatorRecord } from "./resolverOperator.ts"
import { fail, note } from "../output.ts"

export interface Runtime {
  config: CliConfig
  network: Network
  node: AztecNode
  pxe: PXE
  wallet: ObsidionWallet
  contractService: ContractService
  tuple: OxideEnvTuple
  l1: PublicClient
  l1Chain: Chain
  storage: FileStorageAdapter
  /** The reviewed artifact for Oxide's Broadcaster at `address`, by its on-chain class. */
  broadcasterArtifact(address: string): Promise<ContractArtifact>
  /** The oxide registration environment; built on demand because it needs L1 reads. */
  env(): Promise<OxideRegistrationEnv>
  /** The signing account, unlocked from the keystore; a security key asserts once here. */
  account(): Promise<{ unlocked: UnlockedAccount; account: ObsidionAccount }>
  tokenService(): Promise<TokenService>
  close(): Promise<void>
}

export function l1ChainFor(chainId: number): Chain {
  if (chainId === mainnet.id) return mainnet
  if (chainId === sepolia.id) return sepolia
  if (chainId === foundry.id) return foundry
  return { ...foundry, id: chainId, name: `Chain ${chainId}` }
}

export const storagePath = (config: CliConfig) => join(config.home, config.dir, "store.json")

/** The registration controller is the one contract the manifest does not carry; the registry names it. */
async function withRegistrationController(
  l1: PublicClient,
  tuple: OxideEnvTuple,
): Promise<OxideEnvTuple> {
  if (
    (tuple.registrationController && !isAllZeroHex(tuple.registrationController)) ||
    !tuple.registry
  )
    return tuple
  const controller = (await l1.readContract({
    address: tuple.registry as Hex,
    abi: [
      {
        type: "function",
        name: "registrationController",
        stateMutability: "view",
        inputs: [],
        outputs: [{ type: "address" }],
      },
    ],
    functionName: "registrationController",
  })) as Hex
  return isAllZeroHex(controller) ? tuple : { ...tuple, registrationController: controller }
}

/** What a command that only reads gets: no PXE, no keystore, no store, so it cannot sign or write. */
export type ReadOnlyRuntime = Pick<
  Runtime,
  "config" | "network" | "node" | "tuple" | "l1" | "l1Chain"
>

export async function bootReadOnly(opts: Flags = {}): Promise<ReadOnlyRuntime> {
  const config = await loadConfig(opts)
  const network = config.network as Network
  const l1Chain = l1ChainFor(config.l1ChainId)
  const l1 = createPublicClient({
    chain: l1Chain,
    transport: http(config.l1RpcUrl.value, { timeout: 20_000 }),
  }) as PublicClient
  const manifest = await loadOxideManifestTuple({
    manifestUrl: config.oxide.manifestUrl,
    portal: config.addressOverrides.portal ?? config.oxide.portal,
    network,
    expectedGitSha: config.oxide.expectedGitSha,
  })
  const tuple = await withRegistrationController(l1, {
    ...manifest,
    ...(config.addressOverrides.registry ? { registry: config.addressOverrides.registry } : {}),
    ...(config.addressOverrides.token ? { token: config.addressOverrides.token } : {}),
  })
  const node = createNode(config.nodeUrl.value, config.nodeApiKey)
  return { config, network, node, tuple, l1, l1Chain }
}

export async function boot(opts: Flags = {}): Promise<Runtime> {
  const { config, network, node, tuple, l1, l1Chain } = await bootReadOnly(opts)
  const pxe = await createPXE(
    node,
    {
      ...getPXEConfig(),
      proverEnabled: true,
      autoSync: false,
      dataDirectory: join(config.home, config.dir, "pxe"),
    },
    { loggers: {} },
  )
  const wallet = new ObsidionWallet(pxe, node)
  // Contracts resolve to the artifacts the profile's manifest pins for their on-chain class, as in
  // the web wallet; the bundled artifacts are another build of the same contracts.
  const resolveClassArtifact = createClassArtifactResolver(
    createArtifactPinResolver({
      profileUrl: config.profileUrl.value,
      profileId: config.profileId,
      versionId: config.versionId,
      expectedSha256: config.artifactManifestSha256,
    }),
  )
  ContractService.resetInstance()
  const contractService = ContractService.getInstance(
    new NodeContractServiceStorage(network),
    node,
    pxe,
    network,
    {
      source: "profile",
      config: config.snapshot,
      resolveClassArtifact,
      oxideEnvProfile: config.oxide,
    },
  )
  const storage = new FileStorageAdapter(storagePath(config))

  let envPromise: Promise<OxideRegistrationEnv> | undefined
  let accountPromise: Promise<{ unlocked: UnlockedAccount; account: ObsidionAccount }> | undefined
  let tokenPromise: Promise<TokenService> | undefined

  const runtime: Runtime = {
    config,
    network,
    node,
    pxe,
    wallet,
    contractService,
    tuple,
    l1,
    l1Chain,
    storage,
    broadcasterArtifact: (address) =>
      resolveInstanceArtifact(
        node,
        AztecAddress.fromStringUnsafe(address),
        getBroadcasterArtifact,
        resolveClassArtifact,
      ),
    env() {
      envPromise ??= (async () => {
        const claimFpc = config.claimFpcAddress.value
        if (!claimFpc)
          fail(
            "the config profile carries no claimFpc address, so nothing can sponsor this account's transactions",
          )
        const resolverOperator = (await resolverOperatorRecord(runtime)).owner
        return oxideEnvFromTuple(tuple, {
          resolverOperator,
          l1ChainId: config.l1ChainId,
          accountFactory: resolveOxideAccountFactory({ tuple }),
          namePortalRecipient: claimFpc as Hex,
        })
      })()
      return envPromise
    },
    account() {
      accountPromise ??= (async () => {
        const unlocked = await unlockAccount(config.home, config.dir)
        const provider = providerFor(unlocked.authenticator)
        const account = await wallet.getObsidionAccountWallet(unlocked.masterSecret, provider, {
          register: true,
        })
        const l2Address = account.getAddress().toString()
        if (unlocked.file.identity?.l2Address && unlocked.file.identity.l2Address !== l2Address) {
          fail(
            `the account file says ${unlocked.file.identity.l2Address} but the keys derive ${l2Address}`,
            "the passkey or master secret changed; restore the original account file",
          )
        }
        if (!unlocked.file.identity?.l2Address)
          rememberIdentity(config.home, config.dir, { l2Address })
        return { unlocked, account }
      })()
      return accountPromise
    },
    tokenService() {
      tokenPromise ??= (async () => {
        const { account } = await runtime.account()
        const service = await TokenService.create(wallet, account)
        const tee = createOxideTeeSignerSource({
          l1RpcUrl: config.l1RpcUrl.value,
          l1Chain,
          getNode: () => node,
          getTokenAddress: () => contractService.getContractAddress("oxideToken"),
        })
        const signer = await tee.load()
        if (!signer)
          note("note: the attested co-signer is not reachable; operations that need it will fail")
        else service.setTeeSigner(signer)
        return service
      })()
      return tokenPromise
    },
    async close() {
      await pxe.stop?.()
    },
  }
  return runtime
}
