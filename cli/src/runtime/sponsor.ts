/**
 * Fees on mainnet are paid by the deployment's ClaimFPC, so every batch an account sends carries a
 * sponsor context: which FPC instance, which rail, and, until the account holds that rail's
 * subscription note, the witness its gate takes. The NameClaim gate takes the domain owner's L1
 * claim (rebuilt from the registry's `NameClaimed` log); the registration gate takes the NamePortal
 * message the registration sweep emitted, found by scanning the Inbox. Both bind the L2 address with
 * a signature from the master secret's bootstrap key, so nothing here needs a stored secret beyond
 * the account itself.
 */
import { EthAddress } from "@aztec/aztec.js/addresses"
import { Fr } from "@aztec/aztec.js/fields"
import { AztecAddress } from "@aztec/stdlib/aztec-address"
import { concatHex, keccak256, toBytes, toHex, type Address, type Hex } from "viem"
import { DEFAULT_CONTRACTS, L2_BINDING_MESSAGE_PREFIX } from "@obsidion/core/constants"
import {
  NameClaimStore,
  composeWireNameHash,
  createOxideL1Reader,
  deriveBootstrapKey,
  requireVerifiedIdentity,
  resolveOxideAccountFactory,
  resolveOxideIdentity,
  type BootstrapKeyProvider,
  type IdentityGeneration,
  type NameClaimRecord,
  type OxideIdentityDeps,
  type VerifiedOxideIdentity,
} from "../frontCore.ts"
import {
  KIND_BY_ADDRESS,
  REGISTRATION_MESSAGE_SECRET,
  claimFpcPolicySponsorsAnyCall,
  findRegistrationMessage,
  hasClaimFpcSubscription,
  loadClaimFpcPolicy,
  loadClaimFpcPolicyAt,
  readClaimFpcIdentityCatalog,
  readNameClaimLog,
  registerSponsorFpc,
  registrationInbox,
  type ClaimFpcGateWitness,
  type ClaimFpcRailPolicy,
  type ClaimSponsorContext,
  type NameClaimWitness,
  type ObsidionAccount,
  type OxideAccountBinding,
} from "@obsidion/sdk"
import type { Runtime } from "./boot.ts"
import { fail } from "../output.ts"

/** The rail names the deployment declares; the manifest maps them to ids and gates. */
export const RAIL_REGISTRATION_BROADCAST = "registration-broadcast"
export const RAIL_REGISTERED = "registered"
export const RAIL_VOUCHER = "voucher"

export interface Keys {
  account: ObsidionAccount
  secretKey: Fr
}

export async function keysOf(rt: Runtime): Promise<Keys> {
  const { unlocked, account } = await rt.account()
  return { account, secretKey: unlocked.masterSecret }
}

/** The bootstrap key as the account service's request signer. */
export function bootstrapProviderFor(secretKey: Fr): BootstrapKeyProvider {
  const bootstrap = deriveBootstrapKey(secretKey)
  return {
    subject: bootstrap.address.toLowerCase(),
    signClientDataHash: (hash) =>
      bootstrap.sign({ hash: `0x${Buffer.from(hash).toString("hex")}` as Hex }),
  }
}

const bigintTo32 = (value: bigint): Uint8Array => toBytes(toHex(value, { size: 32 }))

/** The L2 address bound to the L1 account by the bootstrap key's signature. */
export async function buildOxideAccountBinding(
  keys: Keys,
  nameHash: Hex,
): Promise<OxideAccountBinding> {
  const bootstrap = deriveBootstrapKey(keys.secretKey)
  const bootstrapPub = toBytes(bootstrap.publicKey)
  const bindingSig = await bootstrap.sign({
    hash: keccak256(
      concatHex([
        toHex(new TextEncoder().encode(L2_BINDING_MESSAGE_PREFIX)),
        keys.account.getAddress().toString() as Hex,
      ]),
    ),
  })
  return {
    nameHash: toBytes(nameHash),
    bootstrapPubKeyX: bootstrapPub.slice(1, 33),
    bootstrapPubKeyY: bootstrapPub.slice(33, 65),
    bindingSig: toBytes(bindingSig).slice(0, 64),
  }
}

export async function buildClaimSubscribeWitness(
  rt: Runtime,
  handle: string,
  keys: Keys,
  claim: { signature: Hex; nonce: string; deadline: string },
  nameHash?: Hex,
): Promise<NameClaimWitness> {
  const ensDomain = rt.tuple.ensDomain
  if (!ensDomain) fail("oxide manifest lacks ensDomain")
  const node = nameHash ?? composeWireNameHash(handle, ensDomain)
  return {
    ...(await buildOxideAccountBinding(keys, node)),
    nonce: bigintTo32(BigInt(claim.nonce)),
    deadline: bigintTo32(BigInt(claim.deadline)),
    claimSig: toBytes(claim.signature).slice(0, 64),
  }
}

export const nameClaims = (rt: Runtime) => NameClaimStore.get(rt.storage)

/** Rebuild the claim from the registry's log: the bootstrap key predicts the L1 account it was logged against. */
export async function recoverNameClaim(
  rt: Runtime,
  keys: Keys,
  tag: string | undefined,
): Promise<NameClaimRecord | null> {
  const registry = rt.tuple.registry as Address | undefined
  if (!registry) return null
  const oxideAccount = await createOxideL1Reader(rt.l1).predictAccountAddress(
    resolveOxideAccountFactory({ tuple: rt.tuple }),
    deriveBootstrapKey(keys.secretKey).address,
  )
  const log = await readNameClaimLog(rt.l1 as never, registry, oxideAccount as Address)
  if (!log) return null
  const record: NameClaimRecord = {
    address: keys.account.getAddress().toString(),
    handle: tag ?? "",
    nameHash: log.nameHash,
    signature: log.signature,
    nonce: log.nonce,
    deadline: log.deadline,
  }
  await nameClaims(rt).put(record)
  return record
}

async function sponsorFor(
  rt: Runtime,
  rail: ClaimFpcRailPolicy,
  address: AztecAddress,
): Promise<ClaimSponsorContext> {
  const artifact = await rt.contractService.getArtifactForContract(
    DEFAULT_CONTRACTS.claimFpc,
    address,
  )
  const fpcArtifact = await registerSponsorFpc(rt.wallet, {
    fpcAddress: address,
    fpcArtifact: artifact,
    railId: rail.railId,
    gate: rail.gate,
    policy: rail.policy,
  })
  return {
    fpcAddress: address,
    fpcArtifact,
    railId: rail.railId,
    gate: rail.gate,
    policy: rail.policy,
  }
}

/** The deployment's ClaimFPC for a rail, registered in this PXE, with no subscribe leg. */
export async function claimSponsorRail(
  rt: Runtime,
  railName: string,
): Promise<{ sponsor: ClaimSponsorContext; rail: ClaimFpcRailPolicy }> {
  const { rail, fpcAddress } = await loadClaimFpcPolicy(rt.contractService, railName)
  return { sponsor: await sponsorFor(rt, rail, fpcAddress!), rail }
}

const subscribed = new Map<string, boolean>()

async function needsSubscription(
  rt: Runtime,
  account: ObsidionAccount,
  sponsor: ClaimSponsorContext,
): Promise<boolean> {
  const key = `${account.getAddress().toString()}|${sponsor.fpcAddress.toString()}|${
    sponsor.railId
  }`
  if (subscribed.get(key)) return false
  const has = await hasClaimFpcSubscription(
    rt.wallet,
    sponsor.fpcAddress,
    sponsor.fpcArtifact,
    account.getAddress(),
    sponsor.railId,
  ).catch(() => false)
  if (has) subscribed.set(key, true)
  return !has
}

export function noteSubscribed(account: ObsidionAccount, sponsor: ClaimSponsorContext): void {
  subscribed.set(
    `${account.getAddress().toString()}|${sponsor.fpcAddress.toString()}|${sponsor.railId}`,
    true,
  )
}

/** The NameClaim gate's witness, or undefined when this account never claimed a name. */
async function nameClaimGate(
  rt: Runtime,
  keys: Keys,
  tag: string | undefined,
): Promise<ClaimFpcGateWitness | undefined> {
  const address = keys.account.getAddress().toString()
  const record = (await nameClaims(rt).get(address)) ?? (await recoverNameClaim(rt, keys, tag))
  if (!record) return undefined
  const claim = await buildClaimSubscribeWitness(
    rt,
    record.handle,
    keys,
    { signature: record.signature as Hex, nonce: record.nonce, deadline: record.deadline },
    record.nameHash as Hex | undefined,
  )
  return { kind: "nameClaim", ...claim }
}

export type RegistrationPending =
  { pending: "message" } | { pending: "import"; messageHash: Fr } | { pending: "note" }

export class RegistrationPendingError extends Error {
  constructor(readonly state: RegistrationPending) {
    super(
      state.pending === "message"
        ? "the registration has not reached the network yet: no name message from the portal"
        : state.pending === "import"
          ? "the registration message is on L1 but the rollup has not imported it yet"
          : "the subscription note is still syncing",
    )
    this.name = "RegistrationPendingError"
  }
}

/** The registration gate's witness for one ClaimFPC generation, or why it cannot be built yet. */
async function registrationGate(
  rt: Runtime,
  keys: Keys,
  identity: VerifiedOxideIdentity | undefined,
  generation: { fpcAddress: string; namePortal: string },
): Promise<{ gate: ClaimFpcGateWitness } | RegistrationPending> {
  if (!identity) return { pending: "message" }
  const info = await rt.wallet.node.getNodeInfo()
  const message = await findRegistrationMessage(
    registrationInbox(rt.l1 as never, info.l1ContractAddresses.inboxAddress),
    rt.wallet.node,
    {
      fpc: AztecAddress.fromStringUnsafe(generation.fpcAddress),
      namePortal: EthAddress.fromString(generation.namePortal),
      owner: EthAddress.fromString(identity.account),
      nameHash: Buffer.from(identity.nameHash.replace(/^0x/, ""), "hex"),
      rollupVersion: info.rollupVersion,
      l1ChainId: rt.config.l1ChainId,
    },
  )
  if (!message) return { pending: "message" }
  if (message.status === "pending") return { pending: "import", messageHash: message.messageHash }
  if (message.status === "consumed") return { pending: "note" }
  return {
    gate: {
      kind: "registration",
      ...(await buildOxideAccountBinding(keys, identity.nameHash as Hex)),
      secret: REGISTRATION_MESSAGE_SECRET,
      leafIndex: new Fr(message.leafIndex),
    },
  }
}

/** Every ClaimFPC generation the deployment publishes, for attributing this key's L1 account. */
async function generations(rt: Runtime): Promise<OxideIdentityDeps> {
  const [info, bindings] = await Promise.all([
    rt.wallet.node.getNodeInfo(),
    readClaimFpcIdentityCatalog(rt.wallet, rt.contractService),
  ])
  const registry = rt.tuple.registry as Address | undefined
  if (!registry) fail("oxide manifest lacks registry")
  const rollupVersion = String(info.rollupVersion)
  return {
    reader: createOxideL1Reader(rt.l1),
    registry,
    rollupVersion,
    catalog: bindings.map((b) => ({
      fpcAddress: b.fpcAddress,
      accountFactory: b.accountFactory as Address,
      implementation: b.implementation as Address,
      namePortal: b.namePortal as Address,
      rollupVersion,
    })),
  }
}

export async function verifiedIdentity(
  rt: Runtime,
  keys: Keys,
): Promise<VerifiedOxideIdentity | undefined> {
  const deps = await generations(rt)
  return requireVerifiedIdentity(
    await resolveOxideIdentity(
      deps,
      deriveBootstrapKey(keys.secretKey).address,
      keys.account.getAddress().toString(),
    ),
  )
}

const sameFpc = (a: string, b: string) => a.toLowerCase() === b.toLowerCase()

function railCovers(rail: ClaimFpcRailPolicy, target: AztecAddress): boolean {
  if (claimFpcPolicySponsorsAnyCall(rail.policy)) return true
  return rail.policy.witnesses.some(
    ({ entry }) => entry.kind === KIND_BY_ADDRESS && entry.target.equals(target.toField()),
  )
}

function registrationTargets(
  sponsor: ClaimSponsorContext,
  identity: VerifiedOxideIdentity | undefined,
): IdentityGeneration[] {
  const current = sponsor.fpcAddress.toString()
  const published = identity?.generations ?? []
  return [
    ...published.filter((g) => sameFpc(g.fpcAddress, current)),
    ...published.filter((g) => !sameFpc(g.fpcAddress, current)),
  ]
}

/**
 * The sponsor context a batch from this account rides on `railName`, with its subscribe leg when the
 * account holds no subscription yet. A NameClaim-gated rail takes the claim witness; the registered
 * rail asks each ClaimFPC generation that binds this account for the portal message and throws
 * `RegistrationPendingError` while none can gate it yet.
 */
export async function claimSponsorContext(
  rt: Runtime,
  railName: string,
  tag?: string,
): Promise<ClaimSponsorContext> {
  const keys = await keysOf(rt)
  const { sponsor, rail } = await claimSponsorRail(rt, railName)
  if (rail.gate !== "registration") {
    if (rail.gate === "none" || !(await needsSubscription(rt, keys.account, sponsor)))
      return sponsor
    const gate = await nameClaimGate(rt, keys, tag)
    return gate ? { ...sponsor, subscribe: { gate } } : sponsor
  }
  const token = AztecAddress.fromStringUnsafe(
    rt.tuple.l2Token ?? fail("oxide manifest lacks l2Token"),
  )
  if (railCovers(rail, token) && !(await needsSubscription(rt, keys.account, sponsor)))
    return sponsor
  const identity = await verifiedIdentity(rt, keys)
  let waiting: RegistrationPending | undefined
  for (const generation of registrationTargets(sponsor, identity)) {
    const address = AztecAddress.fromStringUnsafe(generation.fpcAddress)
    const candidate = sameFpc(generation.fpcAddress, sponsor.fpcAddress.toString())
      ? { sponsor, rail }
      : await (async () => {
          const { rail: r } = await loadClaimFpcPolicyAt(
            rt.contractService,
            railName,
            address.toString(),
          )
          return { sponsor: await sponsorFor(rt, r, address), rail: r }
        })()
    if (!railCovers(candidate.rail, token)) continue
    if (!(await needsSubscription(rt, keys.account, candidate.sponsor))) return candidate.sponsor
    const found = await registrationGate(rt, keys, identity, {
      fpcAddress: generation.fpcAddress,
      namePortal: generation.namePortal,
    })
    if ("gate" in found) return { ...candidate.sponsor, subscribe: { gate: found.gate } }
    waiting ??= found
  }
  throw new RegistrationPendingError(waiting ?? { pending: "message" })
}
