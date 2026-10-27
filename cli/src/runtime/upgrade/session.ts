/**
 * The upgrade composed for this CLI: front-core's durable migration session over the file store,
 * the account's authenticator for every passkey prompt, and the v5 generation as the source, which
 * refunds through the migration executor the new deployment publishes for the old portal.
 */
import { OxidePortalContract } from "@oxide/l1-contracts/oxide_portal.js"
import {
  FrozenMetadataMigrationSource,
  frozenRuntimeFromSourceGeneration,
  migrationRouteFor,
  type RefundChallengeSigner,
  type WebAuthnSignResult,
} from "@obsidion/sdk"
import type { OxideEnvTuple } from "@obsidion/core/types"
import type { Address, Hex } from "viem"
import {
  SIPADepositStore,
  UpgradeActivity,
  createMetadataMigrationSession,
  pubkeyToR1KeyArg,
  type PasskeySignResult,
} from "../../frontCore.ts"
import type { Authenticator } from "../../keystore/authenticator.ts"
import { fail } from "../../output.ts"
import type { Runtime } from "../boot.ts"
import { pinnedDeployment } from "../deposits.ts"
import type { GenerationProcess, GenerationSession } from "./generation.ts"
import { sourceDepositDescriptors, sourceLinkRows, type UpgradeSource } from "./source.ts"

/** The key a run is saved under: one per destination, source and account. */
export const upgradeKey = (current: OxideEnvTuple, historic: OxideEnvTuple, address: string) =>
  `metadata-migration/${current.portal.toLowerCase()}/${historic.portal.toLowerCase()}/${address}`

/** An assertion in the form oxide's r1 UserOp signature takes. */
export function passkeySignResult(result: WebAuthnSignResult): PasskeySignResult {
  const clientDataJSON = Buffer.from(result.clientDataJSON).toString("utf8")
  return {
    signature: `0x${Buffer.from(result.signature).toString("hex")}`,
    webauthn: {
      authenticatorData: `0x${Buffer.from(result.authenticatorData).toString("hex")}`,
      clientDataJSON,
      challengeIndex: clientDataJSON.indexOf('"challenge"'),
      typeIndex: clientDataJSON.indexOf('"type"'),
    },
  }
}

export type Upgrade = Awaited<ReturnType<typeof createUpgrade>>

export async function createUpgrade(
  rt: Runtime,
  source: UpgradeSource,
  generation: GenerationProcess,
  session: GenerationSession,
  authenticator: Authenticator,
) {
  const { unlocked, account } = await rt.account()
  const tokenService = await rt.tokenService()
  const secretKey = unlocked.masterSecret
  const client = rt.l1
  const key = upgradeKey(rt.tuple, source.tuple, account.getAddress().toString())
  const depositDescriptors = () => sourceDepositDescriptors(rt, source, session, secretKey)
  const paylinkRows = () => sourceLinkRows(source)
  const deployment = await pinnedDeployment(rt)
  const migration = await createMetadataMigrationSession({
    wallet: rt.wallet,
    account,
    contracts: rt.contractService,
    tokenService,
    current: rt.tuple,
    network: rt.network,
    secretKey,
    client,
    storage: rt.storage,
    lock: (fn) => fn(),
    key,
    passkey: {
      publicKey: pubkeyToR1KeyArg(authenticator.pubkeyHex),
      signChallenge: async (digest: Hex) =>
        passkeySignResult(await authenticator.sign(Buffer.from(digest.slice(2), "hex"))),
    },
    activity: UpgradeActivity.get(rt.storage),
    deposits: SIPADepositStore.get(rt.storage),
    source: async (context, batches, savedRefundSigner, beforeSourceApproval) => {
      const route = migrationRouteFor(
        deployment,
        source.tuple.portal as Address,
        context.destination.portal,
        context.destination.operationExecutor,
      )
      if (!route)
        fail(
          `the new version lists no migration route for the old portal ${source.tuple.portal} yet`,
          "try again later",
        )
      const runtime = await session.refundRuntime({
        tuple: source.tuple,
        tipRecipient: context.destination.operationExecutor,
        depositDescriptors: () => depositDescriptors(),
        paylinkRows,
      })
      // Its passkey prompts go through the saved signer, so a retry asks for none again.
      const saved = {
        ...runtime,
        build: (...args: Parameters<typeof runtime.build>) =>
          generation.withSigner(
            (sign) => {
              const signer: RefundChallengeSigner = savedRefundSigner((challenge) =>
                sign(challenge),
              )
              return (challenge) => signer(Buffer.from(challenge))
            },
            () => runtime.build(...args),
          ),
      }
      const asset = await new OxidePortalContract(
        client as never,
        context.destination.portal,
      ).getUnderlying()
      return new FrozenMetadataMigrationSource({
        ...context,
        client,
        wallet: rt.wallet,
        batches,
        runtime: frozenRuntimeFromSourceGeneration(saved, beforeSourceApproval, { route, client }),
        destinationAsset: asset.toString() as Address,
      })
    },
  })
  return { ...migration, key }
}
