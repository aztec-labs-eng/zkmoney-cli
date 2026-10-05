/**
 * Registration by deposit from the terminal, on the machine the web wallet drives
 * (`startOxideRegistrationSession` / `resumeOxideRegistration`). The account service signs the
 * NameClaim, the machine derives the registration SIPA (the deposit address) and keeps a durable
 * record in the file store, this module publishes the SIPA to relayers on the one-shot
 * `registration-broadcast` rail, and a relayer's sweep of the deposit registers the name. What the
 * web session takes from the browser (passkey, storage, sponsor, L1 client) comes here from the
 * CLI runtime.
 */
import { NO_FROM } from "@aztec/aztec.js/account"
import { Fr } from "@aztec/aztec.js/fields"
import { AztecAddress } from "@aztec/stdlib/aztec-address"
import {
  bytesToHex,
  createWalletClient,
  erc20Abi,
  http,
  parseAbi,
  zeroAddress,
  type Address,
  type Hex,
} from "viem"
import { privateKeyToAccount } from "viem/accounts"
import {
  DEFAULT_CONTRACTS,
  SANDBOX_REGISTRATION_BENEFICIARY_ID,
  WALLET_TOKEN_SYMBOL,
  registrationFloor,
} from "@obsidion/core/constants"
import { isAllZeroHex } from "@obsidion/core/oxide"
import type { NameClaimResponse, RegistrationSchedule } from "@obsidion/core/types"
import {
  AccountServiceClient,
  PendingRegistrationStore,
  SIPADepositStore,
  composeWireNameHash,
  createOxideL1Reader,
  createRegistrationDepositReader,
  createRegistrationSipaDeriver,
  deriveBootstrapKey,
  isTerminalRegistrationPhase,
  matchWireNameHash,
  pubkeyToR1KeyArg,
  rebuildRegistrationBroadcast,
  recordRegistrationBroadcastSent,
  registrationSipaImplementation,
  resumeOxideRegistration,
  retryDelay,
  setActiveNetworkId,
  startOxideRegistrationSession,
  toWebAuthnAuthArg,
  withClaimRetry,
  type AccountPasskey,
  type NameClaimRecord,
  type OxideL1Reader,
  type OxideRegistrationEnv,
  type OxideRegistrationSessionDeps,
  type OxideRegistrationStage,
  type OxideResumeDeps,
  type OxideSessionResult,
  type OxideSignDeps,
  type PendingRegistrationRecord,
  type RegistrationBroadcastPayload,
  type RegistrationBroadcaster,
  type RegistrationSipaSeed,
  type SipaFundingToken,
} from "../frontCore.ts"
import {
  BroadcasterContract,
  Network,
  OxideSipaIntent,
  OxideTokenContract,
  buildClaimSponsorPayload,
  buildClaimSubscribePayload,
  buildSipaSweepBroadcasts,
  claimFpcSponsoredFee,
  encodeLegacyRegistrationProofs,
  encodeRegistrationProofs,
  ensureContractRegisteredInPXE,
  fetchSipaEvents,
  getBroadcasterArtifact,
  readFpcFundingCut,
  readNameClaimLog,
  readSweepEvents,
  type WebAuthnAlphaAuthProvider,
} from "@obsidion/sdk"
import type { Runtime } from "./boot.ts"
import {
  RAIL_REGISTRATION_BROADCAST,
  bootstrapProviderFor,
  claimSponsorContext,
  nameClaims,
  noteSubscribed,
  type Keys,
} from "./sponsor.ts"
import {
  fundingSummary,
  phaseLabel,
  registrationKind,
  registrationQuote,
  scheduleForRecord,
  signedSchedule,
  termsFromClaim,
  type RegistrationQuote,
  type RegistrationTerms,
  type SignedClaim,
  type TokenBalance,
} from "./registrationQuote.ts"
import { sipaFundingTokens } from "./depositFacts.ts"
import { sipaDeployed } from "./deposits.ts"
import { providerFor } from "../keystore/authenticator.ts"
import { readAccountFile, rememberIdentity } from "../keystore/keystore.ts"
import { CliError, fail, note, time } from "../output.ts"

function need(value: string | undefined, field: string): string {
  if (!value || isAllZeroHex(value)) fail(`oxide manifest lacks ${field}`)
  return value
}

// ── Keys ──────────────────────────────────────────────────────────────────────

export interface RegistrationKeys extends Keys {
  /** 0x-prefixed x‖y passkey key: the r1 key the sweep installs on the L1 account. */
  pubkeyHex: string
  credentialId: string
  provider: WebAuthnAlphaAuthProvider
}

export async function registrationKeysOf(rt: Runtime): Promise<RegistrationKeys> {
  const { unlocked, account } = await rt.account()
  const { authenticator } = unlocked
  return {
    account,
    secretKey: unlocked.masterSecret,
    pubkeyHex: `0x${authenticator.pubkeyHex}`,
    credentialId: authenticator.credentialId,
    provider: providerFor(authenticator),
  }
}

/** The passkey as OxideAccount's on-chain verifier takes it: the r1 key and a WebAuthn signer. */
export async function oxideAccountPasskey(
  provider: WebAuthnAlphaAuthProvider,
): Promise<AccountPasskey> {
  const [x, y] = await provider.getPubkeys()
  return {
    key: { qx: bytesToHex(x), qy: bytesToHex(y) },
    sign: async (challenge) => {
      const result = await provider.signChallenge(Buffer.from(challenge.slice(2), "hex"))
      const clientDataJSON = Buffer.from(result.clientDataJSON).toString("utf8")
      const challengeIndex = clientDataJSON.indexOf('"challenge":')
      const typeIndex = clientDataJSON.indexOf('"type":')
      if (challengeIndex < 0 || typeIndex < 0)
        throw new Error("the passkey response is missing its challenge or type")
      return toWebAuthnAuthArg({
        signature: bytesToHex(result.signature),
        webauthn: {
          authenticatorData: bytesToHex(result.authenticatorData),
          clientDataJSON,
          challengeIndex,
          typeIndex,
        },
      })
    },
  }
}

export function accountServiceFor(rt: Runtime, keys: Keys): AccountServiceClient {
  const url = rt.config.accountServiceUrl.value
  if (!url)
    fail(
      "the config profile names no account service, so no NameClaim can be signed",
      "set accountService.url",
    )
  // The sandbox service runs its gate as a pass-through; the bootstrap subject still names the claim's owner.
  return new AccountServiceClient(url, {
    testMode: rt.network === Network.SANDBOX,
    bootstrapProvider: bootstrapProviderFor(keys.secretKey),
  })
}

// ── Context: the chain facts every registration command reads once ──────────────

const SCHEDULE_ABI = parseAbi([
  "function REGISTRATION_MIN() view returns (uint256)",
  "function REGISTRATION_FEE() view returns (uint256)",
  "function beneficiaries(uint256) view returns (address)",
  "function nextBeneficiaryId() view returns (uint256)",
])

export interface RegistrationContext {
  env: OxideRegistrationEnv
  l1: OxideL1Reader
  portal: Address
  feeToken: SipaFundingToken
  fundingTokens: [SipaFundingToken, ...SipaFundingToken[]]
  fpcFundingCut: bigint
  /** The controller's immutable schedule: what a claim without signed terms pays. */
  schedule: RegistrationSchedule
  /** The controller when the deployment has one, else the registry, which then holds the schedule. */
  scheduleSource: Address
  registrationImplementation: Address
  pending: PendingRegistrationStore
}

export async function registrationContext(rt: Runtime): Promise<RegistrationContext> {
  const env = await rt.env()
  const portal = (rt.config.addressOverrides.portal ?? rt.config.oxide.portal) as Address
  const sipaFactory = need(rt.tuple.sipaFactory, "sipaFactory") as Address
  const controller = rt.tuple.registrationController
  const scheduleSource = (
    controller && !isAllZeroHex(controller) ? controller : env.registry
  ) as Address
  const token = env.feeToken
  const [symbol, decimals, fpcFundingCut, min, fee, registrationImplementation] = await Promise.all(
    [
      rt.l1.readContract({ address: token, abi: erc20Abi, functionName: "symbol" }),
      rt.l1.readContract({ address: token, abi: erc20Abi, functionName: "decimals" }),
      readFpcFundingCut(rt.l1 as never, portal),
      rt.l1.readContract({
        address: scheduleSource,
        abi: SCHEDULE_ABI,
        functionName: "REGISTRATION_MIN",
      }),
      rt.l1.readContract({
        address: scheduleSource,
        abi: SCHEDULE_ABI,
        functionName: "REGISTRATION_FEE",
      }),
      registrationSipaImplementation(rt.l1 as never, sipaFactory, portal),
    ],
  )
  const feeToken: SipaFundingToken = { address: token, symbol, decimals }
  const pending = PendingRegistrationStore.get(rt.storage)
  await pending.load()
  return {
    env,
    l1: createOxideL1Reader(rt.l1),
    portal,
    feeToken,
    fundingTokens: sipaFundingTokens(rt.network, feeToken),
    fpcFundingCut,
    schedule: { min, fee },
    scheduleSource,
    registrationImplementation,
    pending,
  }
}

/**
 * The allowlisted fee beneficiary the intent commits to. The configured id when this deployment
 * allowlisted it, else the newest one; a controller seeds only id 0, so a baked-in id can name an
 * entry a deployment never added, and the sweep would revert after the deposit.
 */
export async function resolveBeneficiary(rt: Runtime, source: Address): Promise<Address> {
  const at = (id: bigint) =>
    rt.l1.readContract({
      address: source,
      abi: SCHEDULE_ABI,
      functionName: "beneficiaries",
      args: [id],
    })
  const preferred = await at(SANDBOX_REGISTRATION_BENEFICIARY_ID)
  if (preferred !== zeroAddress) return preferred
  const next = await rt.l1.readContract({
    address: source,
    abi: SCHEDULE_ABI,
    functionName: "nextBeneficiaryId",
  })
  if (next > 0n) {
    const newest = await at(next - 1n)
    if (newest !== zeroAddress) return newest
  }
  fail(
    "the registration controller allowlists no fee beneficiary, so a registration cannot be priced",
  )
}

export const predictedL1Account = (ctx: RegistrationContext, keys: Keys): Promise<Address> =>
  ctx.l1.predictAccountAddress(ctx.env.factory, deriveBootstrapKey(keys.secretKey).address)

// ── Terms: what the claim server quoted, kept beside the record ─────────────────

const TERMS_PREFIX = "zkmoney.registration.terms/v1/"
const termsKey = (account: string, tag: string) =>
  `${TERMS_PREFIX}${account.toLowerCase()}:${tag.toLowerCase()}`

export async function saveRegistrationTerms(rt: Runtime, terms: RegistrationTerms): Promise<void> {
  await rt.storage.setItem(termsKey(terms.account, terms.tag), JSON.stringify(terms))
}

export async function loadRegistrationTerms(
  rt: Runtime,
  account: string,
  tag: string,
): Promise<RegistrationTerms | undefined> {
  const raw = await rt.storage.getItem(termsKey(account, tag))
  return raw ? (JSON.parse(raw) as RegistrationTerms) : undefined
}

export function quoteForRecord(
  ctx: RegistrationContext,
  record: Pick<PendingRegistrationRecord, "fee">,
  terms: RegistrationTerms | undefined,
): RegistrationQuote {
  return registrationQuote(
    scheduleForRecord(record, terms, ctx.schedule),
    registrationKind(terms?.reduced),
    ctx.fpcFundingCut,
  )
}

// ── Collaborators the machine takes ────────────────────────────────────────────

/** The deployment's L2 token, registered in this PXE: it sends the recipient their `SIPA` event. */
async function oxideToken(rt: Runtime): Promise<OxideTokenContract> {
  const address = AztecAddress.fromStringUnsafe(need(rt.tuple.l2Token, "l2Token"))
  const artifact = await rt.contractService.getArtifactForContract(
    DEFAULT_CONTRACTS.oxideToken,
    address,
  )
  await ensureContractRegisteredInPXE(rt.pxe as never, rt.node, address, async () => artifact)
  return OxideTokenContract.at(address, artifact, rt.wallet as never)
}

/** Oxide's Broadcaster, registered in this PXE: nothing else registers it before the wallet opens. */
async function broadcasterContract(rt: Runtime): Promise<BroadcasterContract> {
  const address = AztecAddress.fromStringUnsafe(need(rt.tuple.l2Broadcaster, "l2Broadcaster"))
  const artifact = await rt.broadcasterArtifact(address.toString())
  await ensureContractRegisteredInPXE(rt.pxe as never, rt.node, address, async () => artifact)
  return BroadcasterContract.at(address, artifact, rt.wallet as never)
}

/**
 * Publishes the registration SIPA to relayers: the token's `SIPA` event to this account plus one
 * sweep operation per funding token, in one batch on the one-shot `registration-broadcast` rail.
 * The batch subscribes against the NameClaim and pays for itself, so the fresh claim is cached
 * first: the subscribe leg cannot recover it from a registry that has not logged it yet. Resolves
 * with the tx hash once mined; throws on failure.
 */
export function registrationBroadcaster(
  rt: Runtime,
  ctx: RegistrationContext,
  keys: Keys,
  tag: string,
): RegistrationBroadcaster {
  return async (payload, attempt = {}) => {
    const tuple = rt.tuple
    const address = keys.account.getAddress()
    const deployed = await sipaDeployed(rt, {
      sipa: payload.sipaAddress,
      intent: OxideSipaIntent.Registration,
      deployArgs: payload.sipaArgs,
      intentData: payload.registrationData,
    })
    await nameClaims(rt).put({
      address: address.toString(),
      handle: tag,
      nameHash: composeWireNameHash(tag, need(tuple.ensDomain, "ensDomain")),
      nonce: String(payload.domainAuth.nonce),
      deadline: String(payload.domainAuth.deadline),
      signature: payload.domainAuth.signature,
      ...(payload.signedTerms.signature !== "0x"
        ? {
            terms: {
              fee: String(payload.signedTerms.fee),
              minDeposit: String(payload.signedTerms.minDeposit),
              nonce: String(payload.signedTerms.nonce),
              deadline: String(payload.signedTerms.deadline),
              signature: payload.signedTerms.signature,
            },
          }
        : {}),
    })
    const sponsor = await claimSponsorContext(rt, RAIL_REGISTRATION_BROADCAST, tag)
    const { fpcAddress, fpcArtifact, railId, policy, subscribe } = sponsor
    const [token, broadcaster] = await Promise.all([oxideToken(rt), broadcasterContract(rt)])
    const interactions = buildSipaSweepBroadcasts(token, broadcaster, {
      recipient: AztecAddress.fromStringUnsafe(payload.recipient),
      sharedSecretSalt: Fr.fromString(payload.sharedSecretSalt),
      resweepable: payload.sipaArgs.resweepable,
      intentHash: payload.sipaArgs.intentHash,
      sipa: payload.sipaAddress,
      deployed,
      sipaFactory: need(tuple.sipaFactory, "sipaFactory") as Address,
      intent: OxideSipaIntent.Registration,
      deployArgs: payload.sipaArgs,
      intentData: payload.registrationData,
      proofs: ("recoveryAddress" in payload.sipaArgs
        ? encodeLegacyRegistrationProofs
        : encodeRegistrationProofs)({
        consentSig: payload.consentSig,
        bootstrap: payload.bootstrap,
        domainAuth: payload.domainAuth,
        signedTerms: payload.signedTerms,
        r1Install: payload.r1Install,
      }),
      operationExecutor: need(tuple.operationExecutor, "operationExecutor") as Address,
      depositSubsidy: need(tuple.depositSubsidy, "depositSubsidy") as Address,
      chainId: BigInt(rt.config.l1ChainId),
      tokens: ctx.fundingTokens.map((t) => t.address),
    })
    const innerCalls = (await Promise.all(interactions.map((call) => call.request()))).flatMap(
      (p) => p.calls,
    )
    const common = {
      fpcAddress,
      fpcArtifact,
      railId,
      policy,
      user: address,
      innerCalls,
      classWitnesses: [],
    }
    const txPayload = subscribe
      ? await buildClaimSubscribePayload({ ...common, gate: subscribe.gate })
      : await buildClaimSponsorPayload(common)
    // NO_FROM: the entrypoint's subscription is the eligibility, not a signature over the broadcast.
    const { receipt } = await rt.wallet.sendTx(txPayload, {
      ...attempt,
      from: NO_FROM,
      sendMessagesAs: address,
      additionalScopes: [address],
      fee: claimFpcSponsoredFee(policy, innerCalls),
    })
    noteSubscribed(keys.account, sponsor)
    return receipt.txHash.toString()
  }
}

/**
 * Records the deposit's claim inputs for the SIPA rail: the discovery event cannot tell a
 * registration deposit from a plain one, so the wallet seeds the record itself.
 */
function depositSeeder(rt: Runtime, env: OxideRegistrationEnv) {
  let networkId: Promise<string> | undefined
  return async (seed: RegistrationSipaSeed): Promise<void> => {
    const store = SIPADepositStore.get(rt.storage)
    await store.load()
    const existing = store.get(seed.sipaAddress)
    if (existing?.registrationFee !== undefined) return
    networkId ??= rt.node.getNodeInfo().then((info) => `${rt.network}:${info.rollupVersion}`)
    setActiveNetworkId(await networkId)
    await store.upsert(
      seed.sipaAddress,
      {
        phase: existing?.phase ?? "broadcast",
        reorgEpoch: existing?.reorgEpoch,
        registrationFee: seed.registrationFee.toString(),
      },
      {
        recipientL2Address: seed.recipientL2Address,
        messageSecret: seed.messageSecret,
        recipientHash: seed.recipientHash,
        recoveryAddress: seed.origin.protocol === "legacy-eoa" ? seed.origin.recoveryAddress : "",
        origin: seed.origin,
        l1ChainId: env.l1ChainId,
        amount: "0",
        tokenSymbol: WALLET_TOKEN_SYMBOL,
        startTime: Date.now(),
        tokenAddress: env.feeToken,
        intent: "registration",
      },
    )
  }
}

/** Whether the broadcast mined: the `SIPA` event it sends this account is in the PXE. */
async function registrationBroadcastSeen(
  rt: Runtime,
  record: PendingRegistrationRecord,
): Promise<boolean> {
  const store = SIPADepositStore.get(rt.storage)
  await store.load()
  const salt = store.get(record.sipaAddress as Address)?.messageSecret
  if (!salt) throw new Error(`registration deposit ${record.sipaAddress} is not seeded`)
  const token = await oxideToken(rt)
  const events = await fetchSipaEvents(
    rt.wallet,
    token.address,
    AztecAddress.fromStringUnsafe(record.l2Address),
  )
  const wanted = salt.toLowerCase()
  return events.some((event) => event.sharedSecretSalt.toString().toLowerCase() === wanted)
}

/** Maps a nameHash the registry holds back to a tag this wallet knows. */
function localTagResolver(rt: Runtime, ctx: RegistrationContext) {
  return async (nameHash: Hex): Promise<string | null> => {
    const known = [
      readAccountFile(rt.config.home, rt.config.network)?.identity?.tag,
      ...ctx.pending.list().map((r) => r.tag),
    ]
    for (const tag of known) {
      const match = matchWireNameHash(tag, ctx.env.ensDomain, nameHash)
      if (match) return match
    }
    return null
  }
}

async function signDepsFor(
  rt: Runtime,
  ctx: RegistrationContext,
  keys: RegistrationKeys,
): Promise<OxideSignDeps> {
  const accountService = accountServiceFor(rt, keys)
  accountService.signDomain = reportingFailure(
    "the account service did not re-sign the claim",
    accountService.signDomain.bind(accountService),
  )
  return {
    masterSecret: keys.secretKey,
    accountService,
    r1Key: pubkeyToR1KeyArg(keys.pubkeyHex),
    passkey: await oxideAccountPasskey(keys.provider),
    credentialId: keys.credentialId,
    l1: ctx.l1,
    deriveRegistrationSipa: createRegistrationSipaDeriver({
      publicClient: rt.l1,
      env: ctx.env,
      tuple: rt.tuple,
      network: rt.network,
    }),
    seedSipaDeposit: depositSeeder(rt, ctx.env),
  }
}

// ── Session ────────────────────────────────────────────────────────────────────

export interface StartOptions {
  onStage?: (stage: OxideRegistrationStage) => void
  /** A live record for another tag that this session's record replaces. */
  replaced?: PendingRegistrationRecord
}

export interface StartedRegistration {
  result: OxideSessionResult
  /** The claim the account service signed, hold included; absent when the name was already ours. */
  claim?: SignedClaim
}

/**
 * Prechecks the name, signs the claim, derives the deposit address and checkpoints the record. The
 * caller publishes the broadcast payload the result carries.
 */
export async function startRegistration(
  rt: Runtime,
  ctx: RegistrationContext,
  keys: RegistrationKeys,
  tag: string,
  opts: StartOptions = {},
): Promise<StartedRegistration> {
  const accountService = accountServiceFor(rt, keys)
  const sign = await signDepsFor(rt, ctx, keys)
  let claim: NameClaimResponse | undefined
  const deps: OxideRegistrationSessionDeps = {
    tag,
    env: ctx.env,
    masterSecret: keys.secretKey,
    l2Address: keys.account.getAddress().toString() as Hex,
    accountService: {
      signDomain: async (req) => {
        claim = await withClaimRetry(() => accountService.signDomain(req), {
          onWait: (reason) => note(`${time(Date.now())}  waiting for the claim server (${reason})`),
        })
        return claim
      },
    },
    beneficiary: await resolveBeneficiary(rt, ctx.scheduleSource),
    scheduleFee: async () => ctx.schedule.fee,
    r1Key: sign.r1Key,
    passkey: sign.passkey,
    credentialId: sign.credentialId,
    seedSipaDeposit: sign.seedSipaDeposit,
    l1: ctx.l1,
    deriveRegistrationSipa: sign.deriveRegistrationSipa,
    pendingStore: ctx.pending,
    resolveLocalTag: localTagResolver(rt, ctx),
    onStage: opts.onStage,
    onCheckpoint: async (record) => {
      if (claim) await saveRegistrationTerms(rt, termsFromClaim(record.account, tag, claim))
    },
    ...(opts.replaced
      ? {
          replaced: {
            sipaAddress: opts.replaced.sipaAddress,
            refunded: false,
            broadcastSpent:
              opts.replaced.broadcast || opts.replaced.replaced?.broadcastSpent === true,
          },
        }
      : {}),
  }
  const result = await startOxideRegistrationSession(deps)
  return { result, claim }
}

// ── Resume: detection ticks, funding reads ─────────────────────────────────────

/** front-core's rebuild reads a failed claim request as a wait; say why first. */
function reportingFailure<A extends unknown[], R>(what: string, fn: (...args: A) => Promise<R>) {
  return async (...args: A): Promise<R> => {
    try {
      return await fn(...args)
    } catch (err) {
      note(`note: ${what}: ${(err as Error).message}`)
      throw err
    }
  }
}

/** The resume machine's collaborators. A tick only observes; the register command publishes. */
export async function resumeDeps(rt: Runtime, ctx: RegistrationContext): Promise<OxideResumeDeps> {
  // `termsFor` is synchronous, so the stored terms are read up front for every record.
  const terms = new Map<string, RegistrationTerms>()
  for (const record of ctx.pending.list()) {
    const stored = await loadRegistrationTerms(rt, record.account, record.tag)
    if (stored) terms.set(record.account.toLowerCase(), stored)
  }
  return {
    env: ctx.env,
    l1: ctx.l1,
    deposits: createRegistrationDepositReader({
      publicClient: rt.l1,
      registrationImplementation: ctx.registrationImplementation,
      registry: ctx.env.registry,
      portal: ctx.portal,
      registrationController: ctx.scheduleSource,
      fundingTokens: ctx.fundingTokens,
      termsFor: (account) => {
        const stored = terms.get(account.toLowerCase())
        const record = ctx.pending.get(account)
        const schedule = signedSchedule(stored)
        return schedule && (record?.fee === undefined || schedule.fee === BigInt(record.fee))
          ? { fee: schedule.fee, minDeposit: schedule.min }
          : undefined
      },
    }),
    pendingStore: ctx.pending,
    resolveLocalTag: localTagResolver(rt, ctx),
  }
}

// ── Publishing: owed by the register command once it has shown the address ──────

/** A payload whose claim or signed terms lapse sooner than this is signed again, not sent. */
const PAYLOAD_MARGIN_MS = 30_000

/** When the sweep stops accepting the payload: its claim's deadline, or its signed terms' if sooner. */
function payloadDeadlineMs(payload: RegistrationBroadcastPayload): number {
  const claim = payload.domainAuth.deadline
  const terms = payload.signedTerms.deadline
  return Number(terms > 0n && terms < claim ? terms : claim) * 1000
}

/** Whether the address still needs its broadcast. A spent rail leaves only a manual sweep. */
export const broadcastOwed = (record: PendingRegistrationRecord): boolean =>
  !isTerminalRegistrationPhase(record.phase) &&
  !record.broadcast &&
  record.replaced?.broadcastSpent !== true

/** An attempt at publishing the record's address, when one is due; true once relayers can see it. */
export type RegistrationPublisher = (record: PendingRegistrationRecord) => Promise<boolean>

/**
 * Publishes a record's address as the web wallet's broadcast ledger does: the chain is asked first,
 * so a broadcast that already landed costs a read, not a proof; then `payload`, the session's own,
 * while its claim is live, else a rebuild that re-requests the claim and re-signs the consent. An
 * attempt that does not land backs the next one off; a rebuild that ends the registration fails.
 */
export function registrationPublisher(
  rt: Runtime,
  ctx: RegistrationContext,
  keys: RegistrationKeys,
  payload?: RegistrationBroadcastPayload,
): RegistrationPublisher {
  let failures = 0
  let dueAt = 0
  return async (record) => {
    if (!broadcastOwed(record)) return record.broadcast
    if (Date.now() < dueAt) return false
    try {
      if (!(await registrationBroadcastSeen(rt, record).catch(() => false))) {
        let signed =
          payload?.sipaAddress.toLowerCase() === record.sipaAddress.toLowerCase() &&
          payloadDeadlineMs(payload) > Date.now() + PAYLOAD_MARGIN_MS
            ? payload
            : undefined
        if (!signed) {
          const rebuilt = await rebuildRegistrationBroadcast(
            await resumeDeps(rt, ctx),
            record,
            await signDepsFor(rt, ctx, keys),
          )
          if (rebuilt.kind === "closed")
            fail(
              rebuilt.outcome === "taken"
                ? `@${record.tag} went to another account before its address was published`
                : "the registration cannot go on from this record",
              rebuilt.outcome === "taken"
                ? "pick another tag"
                : `run \`zkmoney register status\`, then \`zkmoney register ${record.tag}\` again`,
            )
          if (rebuilt.kind === "spent") return false
          if (rebuilt.kind === "wait") {
            note(`note: not published yet: ${rebuilt.reason.toLowerCase()}`)
            dueAt = Date.now() + rebuilt.ms
            return false
          }
          signed = rebuilt.payload
        }
        await registrationBroadcaster(rt, ctx, keys, record.tag)(signed)
      }
      await recordRegistrationBroadcastSent(ctx.pending, record.account, record.sipaAddress)
      return true
    } catch (err) {
      if (err instanceof CliError) throw err
      note(`note: the broadcast failed: ${(err as Error).message}`)
      dueAt = Date.now() + retryDelay(++failures)
      return false
    }
  }
}

export interface RegistrationProgress {
  record: PendingRegistrationRecord
  balances: TokenBalance[]
  swept: boolean
  /** true: the registry names this account for the name; null: it names another; false: nobody yet. */
  registered: boolean | null
  floor?: bigint
  terms?: RegistrationTerms
}

export async function readRegistrationProgress(
  rt: Runtime,
  ctx: RegistrationContext,
  record: PendingRegistrationRecord,
): Promise<RegistrationProgress> {
  const sipa = record.sipaAddress as Address
  const [balances, sweeps, owner, terms] = await Promise.all([
    Promise.all(
      ctx.fundingTokens.map(async (token) => ({
        token,
        balance: await rt.l1.readContract({
          address: token.address,
          abi: erc20Abi,
          functionName: "balanceOf",
          args: [sipa],
        }),
      })),
    ),
    readSweepEvents(rt.l1 as never, sipa),
    ctx.l1.readUserAddress(ctx.env.registry, record.nameHash),
    loadRegistrationTerms(rt, record.account, record.tag),
  ])
  const registered =
    owner === zeroAddress
      ? false
      : owner.toLowerCase() === record.account.toLowerCase()
        ? true
        : null
  const schedule = scheduleForRecord(record, terms, ctx.schedule)
  return {
    record,
    balances,
    swept: sweeps.length > 0,
    registered,
    floor: schedule ? registrationFloor(schedule, ctx.fpcFundingCut) : undefined,
    terms,
  }
}

/** The newest record still in flight, else the newest of any phase. */
export function latestRegistration(
  ctx: RegistrationContext,
  l2Address?: string,
): PendingRegistrationRecord | null {
  return ctx.pending.current(l2Address) ?? ctx.pending.list()[0] ?? null
}

export type WaitOutcome = "confirmed" | "taken" | "failed" | "needs_recovery" | "timeout"

export interface WaitOptions {
  timeoutMs: number
  intervalMs: number
  /** One progress line, without its timestamp. */
  onLine: (line: string) => void
  publish: RegistrationPublisher
}

/**
 * Ticks the record until the registry names the account, the name is lost, or `timeoutMs` passes.
 * Until the relayers have heard about the address, a tick publishes it when an attempt is due, and
 * every change in what the address holds or in the record's phase is reported once.
 */
export async function waitForRegistration(
  rt: Runtime,
  ctx: RegistrationContext,
  record: PendingRegistrationRecord,
  opts: WaitOptions,
): Promise<WaitOutcome> {
  const deps = await resumeDeps(rt, ctx)
  const deadline = Date.now() + opts.timeoutMs
  const expected = { account: record.account, nameHash: record.nameHash }
  let lastFunding: string | undefined
  let lastPhase = record.phase
  let lastBroadcast = record.broadcast
  let lastSwept = record.sweptAt !== undefined
  for (;;) {
    const outcome = await resumeOxideRegistration(deps, { expectedRecord: expected })
    await opts.publish(ctx.pending.get(record.account) ?? record)
    const current = ctx.pending.get(record.account) ?? record
    if (current.broadcast !== lastBroadcast) {
      lastBroadcast = current.broadcast
      if (current.broadcast) opts.onLine("relayers notified")
    }
    if (!isTerminalRegistrationPhase(current.phase)) {
      const progress = await readRegistrationProgress(rt, ctx, current).catch(() => undefined)
      if (progress) {
        const funding = fundingSummary(progress.balances)
        if (funding !== lastFunding) {
          if (lastFunding !== undefined || progress.balances.some((b) => b.balance > 0n))
            opts.onLine(`deposit address holds ${funding}`)
          lastFunding = funding
        }
        if (progress.swept && !lastSwept) {
          lastSwept = true
          opts.onLine("swept; waiting for the registry")
        }
      }
    }
    if (current.phase !== lastPhase) {
      lastPhase = current.phase
      // The tick that finds a sweep also stamps the record funded, which the sweep line supersedes.
      if (!isTerminalRegistrationPhase(current.phase) && current.sweptAt === undefined)
        opts.onLine(phaseLabel(current.phase))
    }
    if (outcome === "confirmed" || outcome === "taken" || outcome === "failed") return outcome
    if (outcome === "needs_recovery") return outcome
    if (Date.now() >= deadline) return "timeout"
    await new Promise((resolve) => setTimeout(resolve, opts.intervalMs))
  }
}

// ── Outcome: identity and the NameClaim cache ──────────────────────────────────

/**
 * Cache the `NameClaimed` entry the registry holds, the artifact the first sponsored batch
 * subscribes with. Never the signer's response: a re-issued claim carries another nonce.
 */
export async function cacheNameClaimFromLog(
  rt: Runtime,
  ctx: RegistrationContext,
  subject: Pick<PendingRegistrationRecord, "account" | "tag" | "l2Address">,
): Promise<NameClaimRecord | null> {
  const log = await readNameClaimLog(rt.l1 as never, ctx.env.registry, subject.account as Address)
  if (!log) return null
  const record: NameClaimRecord = {
    address: subject.l2Address,
    handle: subject.tag,
    nameHash: log.nameHash,
    signature: log.signature,
    nonce: log.nonce,
    deadline: log.deadline,
  }
  await nameClaims(rt).put(record)
  return record
}

/** What a confirmed name owes: the identity in the account file and the claim in the cache. */
export async function rememberRegistered(
  rt: Runtime,
  ctx: RegistrationContext,
  subject: Pick<PendingRegistrationRecord, "account" | "tag" | "l2Address">,
): Promise<void> {
  rememberIdentity(rt.config.home, rt.config.network, {
    l2Address: subject.l2Address,
    l1Account: subject.account,
    tag: subject.tag,
  })
  await cacheNameClaimFromLog(rt, ctx, subject).catch((err: Error) =>
    note(
      `note: the NameClaim was not cached (${err.message}); the first sponsored batch reads the log`,
    ),
  )
}

// ── Funding from an L1 key ─────────────────────────────────────────────────────

export const L1_PRIVATE_KEY_ENV = "ZKMONEY_L1_PRIVATE_KEY"

/** Sends `total` of the fee token from the key in `ZKMONEY_L1_PRIVATE_KEY` to the deposit address. */
export async function fundRegistration(
  rt: Runtime,
  ctx: RegistrationContext,
  sipaAddress: Address,
  total: bigint,
  privateKey: Hex,
): Promise<{ hash: Hex; from: Address }> {
  const account = privateKeyToAccount(privateKey)
  const token = ctx.feeToken
  const balance = await rt.l1.readContract({
    address: token.address,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [account.address],
  })
  if (balance < total)
    fail(
      `${account.address} holds ${balance} base units of ${token.symbol}, less than the ${total} to send`,
      `fund it, or send the deposit from another wallet`,
    )
  const client = createWalletClient({
    account,
    chain: rt.l1Chain,
    transport: http(rt.config.l1RpcUrl.value, { timeout: 20_000 }),
  })
  const hash = await client.writeContract({
    address: token.address,
    abi: erc20Abi,
    functionName: "transfer",
    args: [sipaAddress, total],
  })
  return { hash, from: account.address }
}
