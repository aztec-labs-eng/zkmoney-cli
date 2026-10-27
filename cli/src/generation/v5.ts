/**
 * The Aztec v5 source generation for the CLI: this build's own packages open the v5 PXE the CLI
 * kept for the old network, read the account's SIPAs and refundable funds, and prove refunds to the
 * executor call the host hands over. The web wallet's v5 adapter without its history replay; the
 * host signs every passkey prompt.
 */
import { AztecAddress, EthAddress } from "@aztec/aztec.js/addresses"
import { Fr } from "@aztec/aztec.js/fields"
import type { AztecNode } from "@aztec/aztec.js/node"
import { InboxContract } from "@aztec/ethereum/contracts"
import type { ViemClient } from "@aztec/ethereum/types"
import { createPXE, getPXEConfig, type PXE } from "@aztec/pxe/server"
import { TxHash } from "@aztec/stdlib/tx"
import { createArtifactCatalog } from "@obsidion/config-client"
import { DEFAULT_CONTRACTS, PaylinkActionEnum } from "@obsidion/core/constants"
import type { ContractServiceConfig, OxideEnvTuple } from "@obsidion/core/types"
import {
  ContractService,
  FrozenRefundMigrationRuntime,
  ObsidionAccountContractManager,
  ObsidionWallet,
  PaylinkService,
  TokenService,
  WebAuthnAlphaAuthProvider,
  computeStealthRecipientHash,
  createClassArtifactResolver,
  createNode,
  createTransferEventSource,
  createWithdrawEventSource,
  discoverFrozenEscrows,
  fetchSipaEvents,
  getBroadcasterArtifact,
  loadTeeSigner,
  passkeyRefundOwner,
  readRefundableEscrowNotes,
  readRefundableFrozenDeposits,
  readRefundableFrozenNotes,
  syncSourcePxe,
  type ObsidionAccount,
  type WebAuthnSignResult,
} from "@obsidion/sdk"
import { OxidePortalContract } from "@oxide/l1-contracts"
import { createPublicClient, http, type Address, type Chain, type PublicClient } from "viem"
import { foundry, mainnet, sepolia } from "viem/chains"
import {
  creatorLinksFromRows,
  deriveRefundableSipaSources,
  savingsRoute,
  type PaylinkTransaction,
  type Transaction,
} from "../frontCore.ts"
import {
  SOURCE_GENERATION_PROTOCOL,
  type SourceExecutorCall,
  type SourceGenerationModule,
  type SourceGenerationOpenParams,
  type SourceGenerationSession,
  type SourcePaylinkRows,
  type SourceRefundRuntime,
  type SourceSipaScan,
} from "./protocol.ts"

export const protocol = SOURCE_GENERATION_PROTOCOL
/** The one Aztec release this line is built for, as `scripts/setup.sh` pins it. */
export const aztecVersion = "5.2.0"

export interface V5OpenParams extends Omit<SourceGenerationOpenParams, "account"> {
  account: { secretKey: string; passkey: { x: string; y: string } }
  /** Where this CLI's v5 PXE kept its store for the network. */
  pxeDataDirectory: string
  /** Signs a passkey challenge, on the host. */
  sign(challenge: Buffer): Promise<WebAuthnSignResult>
}

export type V5Session = SourceGenerationSession & { close(): Promise<void> }

const artifacts = new Map()
const artifactStorage = {
  getArtifactCache: () => artifacts,
  setArtifactCache: (name: never, artifact: never) => void artifacts.set(name, artifact),
}

let bound: { contracts: string; node?: AztecNode } | undefined

/** Binds the ContractService singleton to the source version's contracts and artifact manifest. */
function bindContracts(
  o: Pick<SourceGenerationOpenParams, "network" | "contracts" | "artifacts">,
  chain?: { node: AztecNode; pxe: PXE },
) {
  const contracts = JSON.stringify(o.contracts)
  if (bound && bound.contracts === contracts && (!chain || bound.node === chain.node)) return
  if (bound?.node && chain && bound.node !== chain.node)
    throw new Error("The v5 generation serves one source node at a time")
  const catalog = o.artifacts && createArtifactCatalog(o.artifacts)
  ContractService.resetInstance()
  ContractService.getInstance(artifactStorage, chain?.node, chain?.pxe, o.network as never, {
    source: "profile",
    config: o.contracts as ContractServiceConfig,
    ...(catalog && {
      listClassIds: catalog.classIds,
      resolveClassArtifact: createClassArtifactResolver(catalog.resolvePin),
    }),
  })
  bound = { contracts, node: chain?.node }
}

export const accountAddress: SourceGenerationModule["accountAddress"] = async (o) => {
  bindContracts(o)
  const contractName = DEFAULT_CONTRACTS.obsidionAccountAlpha
  const manager = await ObsidionAccountContractManager.create(
    Fr.fromString(o.secretKey),
    o.publicKeyHex,
    {
      artifact: await ContractService.getInstance().getArtifactForContract(contractName),
      contractName,
      pxe: undefined as never,
    },
    false,
  )
  return (await manager.getCompleteAddress()).address.toString()
}

const hexBuffer = (hex: string) => Buffer.from(hex.replace(/^0x/, ""), "hex")

const l1Chain = (id: number): Chain =>
  [mainnet, sepolia, foundry].find((chain) => chain.id === id) ?? {
    ...foundry,
    id,
    name: `Chain ${id}`,
  }

export async function open(params: V5OpenParams): Promise<V5Session> {
  const node = createNode(params.nodeUrl, params.nodeApiKey)
  const { rollupAddress } = await node.getL1ContractAddresses()
  const pxe = await createPXE(
    node,
    {
      ...getPXEConfig(),
      proverEnabled: params.proverEnabled,
      autoSync: false,
      dataDirectory: params.pxeDataDirectory,
    },
    { loggers: {} },
  )
  const wallet = new ObsidionWallet(pxe, node)
  bindContracts(params, { node, pxe })
  const { passkey } = params.account
  const auth = new WebAuthnAlphaAuthProvider(
    hexBuffer(passkey.x),
    hexBuffer(passkey.y),
    (challenge) => params.sign(challenge),
  )
  const account = await wallet.getObsidionAccountWallet(
    Fr.fromString(params.account.secretKey),
    auth,
    {
      register: true,
    },
  )
  const client = createPublicClient({
    chain: l1Chain(params.l1ChainId),
    transport: http(params.l1RpcUrl, { timeout: 20_000 }),
  }) as PublicClient
  return {
    ...session({
      wallet,
      account,
      client,
      masterSecret: Fr.fromString(params.account.secretKey),
      rollupAddress: rollupAddress.toString(),
    }),
    close: () => pxe.stop?.() ?? Promise.resolve(),
  }
}

function session(o: {
  wallet: ObsidionWallet
  account: ObsidionAccount
  client: PublicClient
  masterSecret: Fr
  rollupAddress: string
}): SourceGenerationSession {
  const { wallet, account, client } = o
  const portalOf = (tuple: OxideEnvTuple) =>
    new OxidePortalContract(client as unknown as ViemClient, tuple.portal as Address)
  // Sponsored calls run with the deployment's ClaimFPC as msg_sender, so the notes they mint for
  // the account are tagged with it. A PXE finds those notes only with the FPC as a sender.
  const registerClaimFpc = async (tuple: OxideEnvTuple) => {
    if (tuple.fpcBeneficiary)
      await wallet.registerSender(AztecAddress.fromStringUnsafe(tuple.fpcBeneficiary))
  }
  // Registers what the deployment's `SIPA` events are tagged with, and the token that holds them.
  const prepareSipaScan = async ({ tuple, resolverL2Addresses }: SourceSipaScan) => {
    if (!resolverL2Addresses.length)
      throw new Error("The source deployment has no resolver senders")
    for (const sender of resolverL2Addresses)
      await wallet.registerSender(AztecAddress.fromStringUnsafe(sender))
    await registerClaimFpc(tuple)
    if (!tuple.l2Broadcaster) throw new Error("The source deployment has no Broadcaster")
    const broadcaster = AztecAddress.fromStringUnsafe(tuple.l2Broadcaster)
    const instance = await wallet.node.getContract(broadcaster)
    if (!instance) throw new Error(`Broadcaster instance not found at ${tuple.l2Broadcaster}`)
    await wallet.registerContract(instance, await getBroadcasterArtifact())
    return TokenService.create(wallet, account, AztecAddress.fromStringUnsafe(tuple.l2Token))
  }
  // The account's payment link escrows on the source, found as v5's `sourceFrozenEscrows` finds them.
  const escrows = async (tuple: OxideEnvTuple, paylinkRows: SourcePaylinkRows) => {
    const tokenService = await TokenService.create(
      wallet,
      account,
      AztecAddress.fromStringUnsafe(tuple.l2Token),
    )
    const contractService = ContractService.getInstance()
    return discoverFrozenEscrows({
      paylinkService: new PaylinkService(wallet, account, tokenService, contractService),
      escrows: { wallet, contractService },
      events: createTransferEventSource({
        wallet,
        tokenAddress: tuple.l2Token,
        accountAddress: account.getAddress().toString(),
      }),
      account: account.getAddress(),
      masterSecret: o.masterSecret,
      hints: await creatorLinksFromRows((await paylinkRows()) as Transaction[]),
    })
  }
  /**
   * The open links among `rows` that a frozen refund paid out on L1. Such a refund leaves the link's
   * L2 note unspent, so the rescan reads it as open; one whose escrow holds no refundable note was
   * refunded.
   */
  const refundedLinks = async (tuple: OxideEnvTuple, rows: Transaction[]): Promise<string[]> => {
    const open = (rows as PaylinkTransaction[]).filter(
      (link) =>
        link.action === PaylinkActionEnum.PAY &&
        !!link.txHash &&
        !link.isClaimed &&
        !link.isRefunded &&
        !link.isMigrated,
    )
    const portal = portalOf(tuple)
    if (!open.length || !(await portal.isFrozen())) return []
    await syncSourcePxe({
      node: wallet.node,
      pxe: wallet.pxe,
      rollupVersion: await portal.getRollupVersion(),
    })
    const freezeEnd = await wallet.node.getBlockData({ archive: await portal.getFreezeArchive() })
    if (!freezeEnd) throw new Error("The source freeze archive has no block")
    const lastFrozenBlock = freezeEnd.header.globalVariables.blockNumber
    const tokenService = await TokenService.create(
      wallet,
      account,
      AztecAddress.fromStringUnsafe(tuple.l2Token),
    )
    const token = await tokenService.getTokenContract()
    const contractService = ContractService.getInstance()
    const paylinkService = new PaylinkService(wallet, account, tokenService, contractService)
    const refunded: string[] = []
    for (const link of open) {
      const funded =
        link.blockNumber ??
        (await wallet.node.getTxReceipt(TxHash.fromString(link.txHash!))).blockNumber
      if (funded === undefined || funded > lastFrozenBlock) continue
      // The link's own material only: one escrow, or none when it does not rebuild.
      const found = await discoverFrozenEscrows({
        paylinkService,
        escrows: { wallet, contractService },
        events: { headBlock: async () => 0, listIncoming: async () => [] },
        account: account.getAddress(),
        masterSecret: o.masterSecret,
        hints: await creatorLinksFromRows([link]),
      })
      if (found.length !== 1) continue
      const refundable = await readRefundableEscrowNotes({
        portal,
        token,
        node: wallet.node,
        escrows: found,
      })
      if (!refundable.length) refunded.push(link.txHash!)
    }
    return refunded
  }
  return {
    address: account.getAddress().toString(),
    rollupAddress: o.rollupAddress,

    history: async () => {
      throw new Error("The v5 generation does not replay history for the CLI")
    },

    async balance({ tuple }) {
      await registerClaimFpc(tuple)
      const token = AztecAddress.fromStringUnsafe(tuple.l2Token)
      return (await (await TokenService.create(wallet, account, token)).getBalance()).toString()
    },

    async sipaSources(scan) {
      const { tuple } = scan
      await prepareSipaScan(scan)
      const token = AztecAddress.fromStringUnsafe(tuple.l2Token)
      const events = await fetchSipaEvents(wallet, token, account.getAddress())
      const sources = await deriveRefundableSipaSources({
        events: events.map((event) => ({
          messageSecret: event.sharedSecretSalt.toString(),
          resweepable: event.resweepable,
          intentHash: event.intentHash,
        })),
        recipientL2Address: account.getAddress().toString(),
        stealthPublicKey: {
          x: BigInt(scan.stealthPublicKey.x),
          y: BigInt(scan.stealthPublicKey.y),
        },
        tuple,
        recoveryAccount: scan.recoveryAccount,
      })
      return Promise.all(
        sources.map(async ({ sipaAddress, recipientL2Address, messageSecret }) => ({
          sipaAddress,
          recipientL2Address,
          messageSecret,
          recipientCommitment: (
            await computeStealthRecipientHash(
              Fr.fromString(messageSecret),
              AztecAddress.fromStringUnsafe(recipientL2Address),
            )
          ).toString(),
        })),
      )
    },

    async savingsMoves({ tuple }) {
      await registerClaimFpc(tuple)
      await TokenService.create(wallet, account, AztecAddress.fromStringUnsafe(tuple.l2Token))
      const source = createWithdrawEventSource({
        wallet,
        tokenAddress: tuple.l2Token,
        accountAddress: account.getAddress().toString(),
      })
      const events = await source.listWithdrawals(1, (await source.headBlock()) + 1)
      return events.flatMap(({ sky }) =>
        sky
          ? [
              {
                direction: sky.route === savingsRoute("in") ? ("in" as const) : ("out" as const),
                factory: sky.factory,
                nonce: sky.nonce,
                recipientCommitment: sky.recipientCommitment,
              },
            ]
          : [],
      )
    },

    async frozenSummary({ tuple, depositDescriptors, paylinkRows }) {
      await registerClaimFpc(tuple)
      const portal = portalOf(tuple)
      if (!(await portal.isFrozen())) return undefined
      await syncSourcePxe({
        node: wallet.node,
        pxe: wallet.pxe,
        rollupVersion: await portal.getRollupVersion(),
      })
      const tokenService = await TokenService.create(
        wallet,
        account,
        AztecAddress.fromStringUnsafe(tuple.l2Token),
      )
      const token = await tokenService.getTokenContract()
      const [notes, links, deposits] = await Promise.all([
        readRefundableFrozenNotes({
          portal,
          token,
          node: wallet.node,
          owner: account.getAddress(),
          resolveSpendMetadata: await account.makeSpendMetadataResolver(),
        }),
        readRefundableEscrowNotes({
          portal,
          token,
          node: wallet.node,
          escrows: await escrows(tuple, paylinkRows),
        }),
        readRefundableFrozenDeposits({
          portal,
          inbox: await depositInbox(client as unknown as ViemClient, portal),
          node: wallet.node,
          depositMetadata: await (
            await account.makeDepositSpendMetadataResolver()
          )(account.getAddress()),
          descriptors: await depositDescriptors(),
        }),
      ])
      let ready = 0
      let waiting = 0
      let waitingAmount = 0n
      for (const deposit of deposits) {
        if (!deposit.waits) {
          ready++
          continue
        }
        waiting++
        waitingAmount += BigInt(deposit.descriptor.amount)
      }
      return {
        notes: notes.reduce((sum, { note }) => sum + note.amount.toBigInt(), 0n).toString(),
        links: links.reduce((sum, { note }) => sum + note.amount.toBigInt(), 0n).toString(),
        deposits: ready,
        waiting,
        waitingAmount: waitingAmount.toString(),
      }
    },

    refundedLinks: async ({ tuple, paylinkRows }) =>
      refundedLinks(tuple, (await paylinkRows()) as Transaction[]),

    async refundRuntime({ tuple, tipRecipient, depositDescriptors, paylinkRows }) {
      if (!tuple.plainWithdrawalExecutor)
        throw new Error("The frozen source has no withdrawal executor")
      await registerClaimFpc(tuple)
      const portal = portalOf(tuple)
      const teeSigner = await loadTeeSigner(
        tuple.enclaveUrl,
        portal.address.toString() as never,
        client as never,
      )
      const [info, tokenService, inbox] = await Promise.all([
        wallet.node.getNodeInfo(),
        TokenService.create(
          wallet,
          account,
          AztecAddress.fromStringUnsafe(tuple.l2Token),
          teeSigner,
        ),
        portal.getInbox(),
      ])
      return plainRuntime(
        new FrozenRefundMigrationRuntime({
          node: wallet.node,
          pxe: wallet.pxe,
          token: await tokenService.getTokenContract(),
          portal,
          inbox: new InboxContract(client as unknown as ViemClient, inbox),
          rollup: info.l1ContractAddresses.rollupAddress.toString() as Address,
          rollupVersion: BigInt(info.rollupVersion),
          owner: await passkeyRefundOwner(wallet, account),
          resolveSpendMetadata: await account.makeSpendMetadataResolver(),
          depositMetadata: await (
            await account.makeDepositSpendMetadataResolver()
          )(account.getAddress()),
          depositDescriptors,
          escrows: () => escrows(tuple, paylinkRows),
          teeSigner,
          executor: EthAddress.fromString(tuple.plainWithdrawalExecutor),
          withdrawalSubsidy: tuple.withdrawalSubsidy
            ? EthAddress.fromString(tuple.withdrawalSubsidy)
            : undefined,
          tipRecipient: EthAddress.fromString(tipRecipient),
        }),
      )
    },
  }
}

async function depositInbox(client: ViemClient, portal: OxidePortalContract) {
  return new InboxContract(client, await portal.getInbox())
}

/** The runtime's executor call: an executor and its payloads, as the v5 portal encodes them. */
interface V5ExecutorCall {
  executor: EthAddress
  userPayload: Buffer
  relayerPayload: Buffer
}

/**
 * The runtime builds each refund's executor call in its private `executorCall`: the call of the
 * source's plain withdrawal executor. The host selects the call, so `build` runs on a view of the
 * runtime whose `executorCall` gives the host's call; one build's call never reaches another.
 */
type ExecutorCallOf = (recipient: Address, relayerTip: bigint) => V5ExecutorCall

function executorCallOf(runtime: FrozenRefundMigrationRuntime): ExecutorCallOf {
  const method = (runtime as unknown as { executorCall?: ExecutorCallOf }).executorCall
  if (typeof method !== "function")
    throw new Error("The v5 refund runtime has no executor call to replace")
  return method.bind(runtime)
}

const HEX = /^0x(?:[0-9a-fA-F]{2})*$/

const hex = (bytes: Buffer) => `0x${bytes.toString("hex")}`

function fromHex(value: string, name: string): Buffer {
  if (!HEX.test(value)) throw new Error(`The executor call's ${name} is not hex`)
  return Buffer.from(value.slice(2), "hex")
}

function v5ExecutorCall(call: SourceExecutorCall): V5ExecutorCall {
  return {
    executor: EthAddress.fromString(call.executor),
    userPayload: fromHex(call.userPayload, "user payload"),
    relayerPayload: fromHex(call.relayerPayload, "relayer payload"),
  }
}

function plainRuntime(runtime: FrozenRefundMigrationRuntime): SourceRefundRuntime {
  const plainCall = executorCallOf(runtime)
  return {
    identity: runtime.identity,
    validate: (destinationAsset) => runtime.validate(destinationAsset as Address),
    candidates: async (opts) => {
      // The deposits the read classified, so each deposit candidate names its Inbox leaf.
      const leaves = new Map<string, string>()
      const view: FrozenRefundMigrationRuntime = Object.create(runtime, {
        deposits: {
          value: async (fresh?: boolean) => {
            const read = await runtime["deposits"](fresh)
            for (const { id, descriptor } of read) leaves.set(id, descriptor.messageLeafIndex)
            return read
          },
        },
      })
      const { waiting, maxBatchAmount, ...read } = await runtime.candidates.call(view, opts)
      return {
        ...read,
        candidates: read.candidates.map((c) => {
          const leafIndex = leaves.get(c.id)
          return leafIndex === undefined ? c : { ...c, leafIndex }
        }),
        maxBatchAmount: maxBatchAmount.toString(),
        ...(waiting === undefined ? {} : { waiting: waiting.toString() }),
      }
    },
    plainExecutorCall: async (recipient, relayerTip) => {
      const call = plainCall(recipient as Address, BigInt(relayerTip))
      return {
        executor: call.executor.toString(),
        userPayload: hex(call.userPayload),
        relayerPayload: hex(call.relayerPayload),
      }
    },
    build: async (selection, executorCall) => {
      const call = v5ExecutorCall(executorCall)
      const view: FrozenRefundMigrationRuntime = Object.create(runtime, {
        executorCall: { value: (() => call) satisfies ExecutorCallOf },
      })
      // The tip is in the host's user payload. The host checks that the amount covers it.
      const built = await runtime.build.call(
        view,
        selection,
        call.executor.toString() as Address,
        0n,
      )
      return {
        amount: built.amount.toString(),
        operation: {
          target: built.operation.target.toString(),
          payoutToken: built.operation.payoutToken.toString(),
          calldata: hex(built.operation.calldata),
        },
      }
    },
    refunded: (ids) => runtime.refunded(ids),
  }
}
