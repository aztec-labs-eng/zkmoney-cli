/**
 * SIPA deposits for this account: an L1 address whose sweeps credit only this account, published
 * through a ClaimFPC-sponsored broadcast so oxide's relayer sweeps whatever lands there, and the
 * recipient-side discovery and claim that turn each sweep into balance. The address is derived here,
 * not asked of the resolver: ECDH is symmetric, so the account's stealth key against the resolver's
 * registry key reproduces exactly what the resolver would derive. The broadcast is the one proof;
 * a first-ever one folds the rail's deferred subscription into the same tx. Records live in
 * front-core's `SIPADepositStore` over the file store, so the activity feed reads them too.
 */
import { randomUUID } from "node:crypto"
import { NO_FROM } from "@aztec/aztec.js/account"
import { AztecAddress } from "@aztec/stdlib/aztec-address"
import { TxHash } from "@aztec/stdlib/tx"
import { erc20Abi, formatUnits, type Address, type Hex } from "viem"
import { DEFAULT_CONTRACTS, quotedDepositFee } from "@obsidion/core/constants"
import type { OxideEnvTuple } from "@obsidion/core/types"
import {
  BroadcasterContract,
  OxideTokenContract,
  SipaSelfResolver,
  TX_AMOUNT_CAP,
  buildClaimSponsorPayload,
  buildClaimSubscribePayload,
  buildSipaSweepBroadcasts,
  chainEpochDay,
  claimFpcSponsoredFee,
  deriveSharedSecret,
  ensureContractRegisteredInPXE,
  fetchSipaEvents,
  getBroadcasterArtifact,
  readDepositFee,
  readFpcFundingCut,
  readSipaFundingStatus,
  selfSipaNonce,
  type ClaimSponsorContext,
  type SelfResolvedSipa,
  type SipaFundingStatus,
  type SipaResolverOperatorRecord,
} from "@obsidion/sdk"
import {
  ContactStorage,
  SIPADepositStore,
  createOxideL1Reader,
  depositSipaImplementation,
  deriveBootstrapKey,
  deriveStealthKey,
  getActiveNetworkId,
  isFailedSubmission,
  isLoggingEnabled,
  isSettledSipaPhase,
  resolveOxideAccountFactory,
  setActiveNetworkId,
  setLoggingEnabled,
  setupSipaDiscovery,
  syncSipaDeposits,
  trackSubmission,
  upsertDepositL1WalletContact,
  type SIPADepositRecord,
  type SipaDepositSyncResult,
  type SipaDiscoverySetup,
  type SipaFundingToken,
  type SipaOrigin,
} from "../frontCore.ts"
import type { Runtime } from "./boot.ts"
import {
  RAIL_REGISTERED,
  claimSponsorContext,
  keysOf,
  noteSubscribed,
  type Keys,
} from "./sponsor.ts"
import { DepositSlots, depositScope, readAllSlots, type DepositSlot } from "./depositSlots.ts"
import {
  depositPhaseLabel,
  feeScale,
  sipaFundingTokens,
  type DepositPhaseLabel,
} from "./depositFacts.ts"
import { fail, note } from "../output.ts"

function field<K extends keyof OxideEnvTuple>(
  tuple: OxideEnvTuple,
  key: K,
): NonNullable<OxideEnvTuple[K]> {
  const value = tuple[key]
  if (!value) fail(`oxide manifest lacks ${key}`)
  return value
}

export interface DepositTokens {
  /** The manifest L1 token, which every sweep settles in. */
  token: SipaFundingToken
  /** Every token a deposit address accepts, `token` first. */
  accepted: [SipaFundingToken, ...SipaFundingToken[]]
}

const tokensCache = new WeakMap<Runtime, Promise<DepositTokens>>()

export function depositTokens(rt: Runtime): Promise<DepositTokens> {
  let pending = tokensCache.get(rt)
  if (!pending) {
    pending = (async () => {
      const address = field(rt.tuple, "token") as Address
      const [decimals, symbol] = await Promise.all([
        rt.l1.readContract({ address, abi: erc20Abi, functionName: "decimals" }),
        rt.l1.readContract({ address, abi: erc20Abi, functionName: "symbol" }),
      ])
      const token = { address, symbol, decimals }
      return { token, accepted: sipaFundingTokens(rt.network, token) }
    })()
    tokensCache.set(rt, pending)
  }
  return pending
}

/** What a depositor is quoted, read live off the portal's deposit implementation and the portal. */
export interface DepositFacts extends DepositTokens {
  /** The relayer's sweep fee, manifest-token base units. */
  sweepFee: bigint
  /** The portal's funding cut, manifest-token base units. */
  fpcFundingCut: bigint
  /** Both halves: the whole fee a deposit pays. */
  fee: bigint
  /** The most one deposit may credit, manifest-token base units. */
  cap: bigint
  implementation: Address
}

export async function readDepositFacts(rt: Runtime): Promise<DepositFacts> {
  const tokens = await depositTokens(rt)
  const portal = field(rt.tuple, "portal") as Address
  const implementation = await depositSipaImplementation(
    rt.l1,
    field(rt.tuple, "sipaFactory") as Address,
    portal,
  )
  const [sweepFee, fpcFundingCut] = await Promise.all([
    readDepositFee(rt.l1, implementation),
    readFpcFundingCut(rt.l1, portal),
  ])
  return {
    ...tokens,
    sweepFee,
    fpcFundingCut,
    fee: quotedDepositFee(sweepFee, fpcFundingCut),
    cap: TX_AMOUNT_CAP,
    implementation,
  }
}

export async function depositStore(rt: Runtime): Promise<SIPADepositStore> {
  const store = SIPADepositStore.get(rt.storage)
  await store.load()
  return store
}

const discoveries = new WeakMap<Runtime, Promise<SipaDiscoverySetup>>()

/**
 * Register the resolver, the sponsoring FPC and the Broadcaster in this PXE, once per process. Needed
 * before broadcasting, not only before syncing: without the sender preimages the PXE cannot discover
 * the `SIPA` event this account sends itself.
 */
export function ensureDiscovery(rt: Runtime): Promise<SipaDiscoverySetup> {
  let pending = discoveries.get(rt)
  if (!pending) {
    pending = (async () =>
      // front-core's PXE and node surfaces union the v4 and v5 shapes; this is the v5 one.
      setupSipaDiscovery({
        pxe: rt.pxe as never,
        node: rt.node,
        publicClient: rt.l1,
        tuple: rt.tuple,
        network: rt.network,
        sponsorFpc: await rt.contractService.getContractAddress(DEFAULT_CONTRACTS.claimFpc),
        artifactFor: (address) => rt.broadcasterArtifact(address.toString()),
      }))().catch((err) => {
      discoveries.delete(rt)
      throw err
    })
    discoveries.set(rt, pending)
  }
  return pending
}

/** Records stamp the active network; set it the way the sync coordinator does when nothing has yet. */
async function stampNetworkId(rt: Runtime): Promise<void> {
  if (getActiveNetworkId()) return
  setActiveNetworkId(`${rt.network}:${(await rt.node.getNodeInfo()).rollupVersion}`)
}

function recoveryAccountOf(rt: Runtime, keys: Keys): Promise<Address> {
  return createOxideL1Reader(rt.l1).predictAccountAddress(
    resolveOxideAccountFactory({ tuple: rt.tuple }),
    deriveBootstrapKey(keys.secretKey).address,
  ) as Promise<Address>
}

interface Derived extends SelfResolvedSipa {
  user: AztecAddress
}

/** The address for `(day, nonce)`: the stealth ECDH against the resolver's key, then the factory's CREATE2. */
async function derive(
  rt: Runtime,
  keys: Keys,
  resolver: SipaResolverOperatorRecord,
  day: number,
  nonce: number,
): Promise<Derived> {
  const tuple = rt.tuple
  const user = keys.account.getAddress()
  const stealth = deriveStealthKey(keys.secretKey)
  const resolved = await new SipaSelfResolver(
    stealth.scalar,
    resolver.resolverPublicKey,
  ).resolveAddress({
    protocol: tuple.sipaRecoveryProtocol ?? "legacy-eoa",
    user,
    recoveryAccount: await recoveryAccountOf(rt, keys),
    day,
    nonce,
    publicClient: rt.l1,
    sipaFactory: field(tuple, "sipaFactory") as Address,
    portal: field(tuple, "portal") as Address,
    rollupVersion: BigInt(field(tuple, "rollupVersion")),
  })
  return { ...resolved, user }
}

/** The record a derivation leaves before its event exists, so the sync pass can pin the event to it. */
async function recordDerivation(
  rt: Runtime,
  derived: Derived,
  tokens: DepositTokens,
): Promise<void> {
  const store = await depositStore(rt)
  const { sipaAddress, sipaArgs, resolution, user } = derived
  const sipaFactory = field(rt.tuple, "sipaFactory") as Address
  const origin: SipaOrigin =
    "recoveryAddress" in sipaArgs
      ? {
          protocol: "legacy-eoa",
          sipaFactory,
          ...sipaArgs,
          rollupVersion: sipaArgs.rollupVersion.toString(),
        }
      : {
          protocol: "account",
          sipaFactory,
          ...sipaArgs,
          rollupVersion: sipaArgs.rollupVersion.toString(),
          recoveryAccount: resolution.recoveryAccount.toString() as Address,
          accountFactory: field(rt.tuple, "accountFactory") as Address,
        }
  await store.upsert(
    sipaAddress,
    { phase: store.get(sipaAddress)?.phase ?? "resolved", origin },
    {
      recipientL2Address: user.toString(),
      messageSecret: resolution.messageSecret.toString(),
      recipientHash: resolution.recipientHash.toString(),
      recoveryAddress: "",
      l1ChainId: rt.config.l1ChainId,
      tokenAddress: tokens.token.address,
      amount: "0",
      tokenSymbol: tokens.token.symbol,
      startTime: Date.now(),
    },
  )
}

/**
 * Slots the chain already shows broadcast today: this account's own `SIPA` events carry each slot's
 * secret, so slot k is used when its secret is among them. Covers another device, or this store
 * before it was cleared.
 */
async function usedSlotsToday(
  rt: Runtime,
  keys: Keys,
  resolver: SipaResolverOperatorRecord,
  day: number,
): Promise<number> {
  const events = await fetchSipaEvents(
    rt.wallet,
    AztecAddress.fromStringUnsafe(field(rt.tuple, "l2Token")),
    keys.account.getAddress(),
  )
  const salts = new Set(events.map((e) => e.sharedSecretSalt.toString()))
  const scalar = deriveStealthKey(keys.secretKey).scalar
  let used = 0
  while (
    salts.has(
      deriveSharedSecret(resolver.resolverPublicKey, scalar, day, selfSipaNonce(used)).toString(),
    )
  )
    used++
  return used
}

/**
 * The sponsored L2 tx that tells the relayer the address exists: the token's `SIPA` event to this
 * account and one deploy-and-sweep operation per accepted token through the Broadcaster. NO_FROM:
 * the rail's subscription is the eligibility, so no signature is asked of the account.
 */
async function broadcast(
  rt: Runtime,
  keys: Keys,
  sponsor: ClaimSponsorContext,
  derived: Derived,
  tokens: DepositTokens,
  onSubmitted: (txHash: Hex) => Promise<void>,
): Promise<string> {
  const tuple = rt.tuple
  const { user, sipaAddress, sipaArgs, intent, resolution } = derived
  const l2Token = AztecAddress.fromStringUnsafe(field(tuple, "l2Token"))
  const tokenArtifact = await rt.contractService.getArtifactForContract(
    DEFAULT_CONTRACTS.oxideToken,
    l2Token,
  )
  await ensureContractRegisteredInPXE(rt.pxe, rt.node, l2Token, async () => tokenArtifact)
  const token = OxideTokenContract.at(l2Token, tokenArtifact, rt.wallet as never)
  const broadcaster = BroadcasterContract.at(
    AztecAddress.fromStringUnsafe(field(tuple, "l2Broadcaster")),
    await rt.broadcasterArtifact(field(tuple, "l2Broadcaster")),
    rt.wallet as never,
  )
  const interactions = buildSipaSweepBroadcasts(token, broadcaster, {
    recipient: user,
    sharedSecretSalt: resolution.messageSecret,
    resweepable: sipaArgs.resweepable,
    intentHash: intent.intentHash,
    sipa: sipaAddress,
    sipaFactory: field(tuple, "sipaFactory") as Address,
    deployArgs: sipaArgs,
    intentData: intent.intentData,
    proofs: intent.proofs,
    operationExecutor: field(tuple, "operationExecutor") as Address,
    depositSubsidy: field(tuple, "depositSubsidy") as Address,
    chainId: BigInt(rt.config.l1ChainId),
    tokens: tokens.accepted.map((t) => t.address),
  })
  const innerCalls = (await Promise.all(interactions.map((call) => call.request()))).flatMap(
    (payload) => payload.calls,
  )
  const { fpcAddress, fpcArtifact, railId, policy, subscribe } = sponsor
  // The broadcast matches the policy by address or its any-call entry: no class witness.
  const common = { fpcAddress, fpcArtifact, railId, policy, user, innerCalls, classWitnesses: [] }
  const payload = subscribe
    ? await buildClaimSubscribePayload({ ...common, gate: subscribe.gate })
    : await buildClaimSponsorPayload(common)
  const operationId = `deposit_${randomUUID()}`
  const tracker = trackSubmission(operationId, onSubmitted)
  try {
    const { receipt } = await rt.wallet.sendTx(payload, {
      from: NO_FROM,
      sendMessagesAs: user,
      additionalScopes: [user],
      fee: claimFpcSponsoredFee(policy, innerCalls),
      operationId,
    })
    if (subscribe) noteSubscribed(keys.account, sponsor)
    return receipt.txHash.toString()
  } finally {
    await tracker.stop()
  }
}

type BroadcastState = "included" | "pending" | "dropped"

/** An unreachable node reads as pending: nothing is repeated on a guess. */
async function broadcastState(rt: Runtime, txHash: string): Promise<BroadcastState> {
  try {
    const receipt = await rt.node.getTxReceipt(TxHash.fromString(txHash))
    if (isFailedSubmission(receipt)) return "dropped"
    return receipt.blockNumber !== undefined ? "included" : "pending"
  } catch {
    return "pending"
  }
}

const BROADCAST_POLL_MS = 5_000
const BROADCAST_WAIT_MS = 5 * 60_000

async function awaitBroadcast(rt: Runtime, txHash: string): Promise<"included" | "dropped"> {
  for (let waited = 0; ; waited += BROADCAST_POLL_MS) {
    const state = await broadcastState(rt, txHash)
    if (state !== "pending") return state
    if (waited === 0) note(`waiting for an earlier broadcast (${txHash}) to land`)
    if (waited >= BROADCAST_WAIT_MS)
      fail(
        `the broadcast ${txHash} is still pending after ${BROADCAST_WAIT_MS / 60_000} minutes`,
        "wait for it to land, then run this again",
      )
    await new Promise((r) => setTimeout(r, BROADCAST_POLL_MS))
  }
}

export interface DepositRequest {
  asset: string
  amount?: string
}

export interface CreatedDeposit {
  address: Address
  /** `<tag>.<ensDomain>` when the account holds a tag. Display only. */
  name?: string
  /** The L2 hash of the broadcast that published the address. */
  txHash: string
  slot: DepositSlot
  /** The address was derived by an earlier run whose broadcast never landed; it is published now. */
  resumed: boolean
}

/**
 * A fresh deposit address, published. Each address is handed out once, so a new run derives a new
 * one, except when an earlier run's broadcast never landed: that address is finished first, so
 * whatever a depositor already sent there is not stranded. The sponsor leg comes before any slot is
 * taken, so a registration the rollup has not imported yet costs nothing here.
 */
export async function createDeposit(rt: Runtime, request: DepositRequest): Promise<CreatedDeposit> {
  const keys = await keysOf(rt)
  const [tokens, { resolver }] = await Promise.all([depositTokens(rt), ensureDiscovery(rt)])
  await stampNetworkId(rt)
  const account = keys.account.getAddress().toString()
  const slots = new DepositSlots(
    rt.storage,
    depositScope(rt.network, field(rt.tuple, "portal"), account),
  )
  const tag = (await rt.account()).unlocked.file.identity?.tag
  const name = tag && rt.tuple.ensDomain ? `${tag}.${rt.tuple.ensDomain}` : undefined
  const sponsor = await claimSponsorContext(rt, RAIL_REGISTERED, tag)

  const [pending] = await slots.unpublished()
  let slot: DepositSlot
  let derived: Derived
  if (pending) {
    if (
      pending.broadcastTxHash &&
      (await awaitBroadcast(rt, pending.broadcastTxHash)) === "included"
    ) {
      slot = { ...pending, published: true }
      await slots.put(slot)
      return { address: slot.address, name, txHash: pending.broadcastTxHash, slot, resumed: true }
    }
    derived = await derive(rt, keys, resolver, pending.day, pending.nonce)
    // The user may already have shared `pending.address`; publishing anything else strands it.
    if (derived.sipaAddress.toLowerCase() !== pending.address.toLowerCase())
      fail(
        `the deposit address for slot ${pending.day}/${pending.nonce} no longer derives to ${pending.address}`,
        "the deployment or the account keys changed; funds sent there need recovery",
      )
    slot = { ...pending, request, broadcastTxHash: undefined }
  } else {
    const day = await chainEpochDay(rt.wallet)
    const nonce = selfSipaNonce(
      await slots.takeSlot(day, await usedSlotsToday(rt, keys, resolver, day)),
    )
    derived = await derive(rt, keys, resolver, day, nonce)
    slot = {
      address: derived.sipaAddress,
      day,
      nonce,
      published: false,
      request,
      createdAt: Date.now(),
    }
    // Saved before the proof, so a run that dies mid-broadcast leaves a slot to finish, not an orphan.
    await slots.put(slot)
    await recordDerivation(rt, derived, tokens)
  }
  const txHash = await broadcast(rt, keys, sponsor, derived, tokens, (hash) =>
    slots.put({ ...slot, broadcastTxHash: hash }),
  )
  slot = { ...slot, published: true, broadcastTxHash: txHash }
  await slots.put(slot)
  return { address: derived.sipaAddress, name, txHash, slot, resumed: !!pending }
}

/** Front-core's routine logs go to stdout; the sync runs silent unless ZKMONEY_DEBUG is set. */
async function quietly<T>(run: () => Promise<T>): Promise<T> {
  if (process.env.ZKMONEY_DEBUG) return run()
  const was = isLoggingEnabled()
  setLoggingEnabled(false)
  try {
    return await run()
  } finally {
    setLoggingEnabled(was)
  }
}

/**
 * One recipient-side pass: discover this account's `SIPA` events, scan each address for the L1
 * `Sweep`, claim every settled one into the PXE (a free utility simulation) and keep the records
 * current. `refreshBalance` runs after each claim; the caller's own tick covers it otherwise.
 */
export async function syncDeposits(
  rt: Runtime,
  opts: { refreshBalance?: () => Promise<void> } = {},
): Promise<SipaDepositSyncResult> {
  const keys = await keysOf(rt)
  const [tokens, tokenService] = await Promise.all([depositTokens(rt), rt.tokenService()])
  await ensureDiscovery(rt)
  await stampNetworkId(rt)
  ContactStorage.get(rt.storage)
  const store = await depositStore(rt)
  const recoveryAccount = await recoveryAccountOf(rt, keys)
  return quietly(() =>
    syncSipaDeposits({
      publicClient: rt.l1,
      node: rt.node as never,
      wallet: rt.wallet,
      tokenService,
      refreshBalance: opts.refreshBalance,
      store,
      tuple: rt.tuple,
      recipient: keys.account.getAddress(),
      stealthPublicKey: deriveStealthKey(keys.secretKey).publicKey,
      recoveryAccount,
      token: tokens.token,
      fundingTokens: tokens.accepted,
      l1ChainId: rt.config.l1ChainId,
      // A registration address is priced by its signed schedule, which this rail does not hold; its
      // phase is held for a pass that can price it.
      registrationScheduleFor: () => null,
      onFundingWalletDetected: upsertDepositL1WalletContact,
    }),
  )
}

/** A deposit record with what the chain says about it now. */
export interface DepositView {
  record: SIPADepositRecord
  slot?: DepositSlot
  label: DepositPhaseLabel
  /** The address's live L1 holding; absent once the deposit settled or when the read failed. */
  funding?: { token: SipaFundingToken; balance: bigint; sweepable: boolean }
  /** The live read failed; the view is the record alone. */
  readError?: string
}

/** The accepted token holding funds at the address: the first sweepable one, else the largest balance. */
async function readFunding(
  rt: Runtime,
  record: SIPADepositRecord,
  facts: DepositFacts,
): Promise<{ token: SipaFundingToken; status: SipaFundingStatus }> {
  let best: { token: SipaFundingToken; status: SipaFundingStatus } | undefined
  for (const token of facts.accepted) {
    const status = await readSipaFundingStatus(rt.l1 as never, {
      sipa: record.sipaAddress,
      token: token.address,
      implementation: facts.implementation,
      fee: bigMax(facts.sweepFee, BigInt(record.registrationFee ?? 0)),
      fpcFundingCut: facts.fpcFundingCut,
      balanceScale: feeScale(facts.token, token),
    })
    if (!best || status.scaledBalance > best.status.scaledBalance) best = { token, status }
    if (status.sweepable) return { token, status }
  }
  return best!
}

async function viewDeposit(
  rt: Runtime,
  record: SIPADepositRecord,
  facts: DepositFacts,
  slot?: DepositSlot,
): Promise<DepositView> {
  if (isSettledSipaPhase(record.phase)) return { record, slot, label: depositPhaseLabel(record) }
  try {
    const { token, status } = await readFunding(rt, record, facts)
    return {
      record,
      slot,
      label: depositPhaseLabel(record, status.balance),
      funding: { token, balance: status.balance, sweepable: status.sweepable },
    }
  } catch (err) {
    return {
      record,
      slot,
      label: depositPhaseLabel(record),
      readError: err instanceof Error ? err.message : String(err),
    }
  }
}

/** Every record with its live view, newest first. Read one at a time: the L1 RPC is usually a public one. */
export async function listDepositViews(
  rt: Runtime,
): Promise<{ facts: DepositFacts; views: DepositView[] }> {
  const [facts, store, slots] = await Promise.all([
    readDepositFacts(rt),
    depositStore(rt),
    readAllSlots(rt.storage),
  ])
  const views: DepositView[] = []
  for (const record of store.list()) {
    views.push(await viewDeposit(rt, record, facts, slots.get(record.sipaAddress.toLowerCase())))
  }
  return { facts, views }
}

export async function getDepositView(
  rt: Runtime,
  address: string,
): Promise<{ facts: DepositFacts; view: DepositView } | undefined> {
  const store = await depositStore(rt)
  const record = store.get(address as Address)
  if (!record) return undefined
  const [facts, slots] = await Promise.all([readDepositFacts(rt), readAllSlots(rt.storage)])
  const view = await viewDeposit(rt, record, facts, slots.get(address.toLowerCase()))
  return { facts, view }
}

const bigMax = (a: bigint, b: bigint) => (a > b ? a : b)
