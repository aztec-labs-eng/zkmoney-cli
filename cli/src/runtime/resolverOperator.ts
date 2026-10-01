/**
 * The resolver operator a deployment's SIPAs route through. The SDK finds it by scanning the
 * account metadata registry's `ResolverOperatorUpdated` events from the deployment's start; when
 * that scan comes back empty on a non-mainnet network, the preferred operator the SDK's own policy
 * names is read straight from the registry and accepted if it serves the manifest's portal.
 */
import type { Address, Hex } from "viem"
import { readResolverOperator } from "@oxide/l1-contracts"
import {
  PREFERRED_RESOLVER_OWNER,
  fetchSipaResolverOperators,
  resolverSelectionPolicy,
  selectManifestResolverOperator,
  type SipaResolverOperatorRecord,
} from "@obsidion/sdk"
import { deploymentScanRange } from "../frontCore.ts"
import type { Runtime } from "./boot.ts"
import { note } from "../output.ts"

const records = new Map<Runtime, Promise<SipaResolverOperatorRecord>>()

export function resolverOperatorRecord(rt: Runtime): Promise<SipaResolverOperatorRecord> {
  let pending = records.get(rt)
  if (!pending) {
    pending = resolve(rt).catch((err) => {
      records.delete(rt)
      throw err
    })
    records.set(rt, pending)
  }
  return pending
}

async function resolve(rt: Runtime): Promise<SipaResolverOperatorRecord> {
  const { accountMetadataRegistry, portal, resolverGatewayUrl } = rt.tuple
  if (!accountMetadataRegistry || !portal) {
    throw new Error("oxide manifest lacks accountMetadataRegistry or portal")
  }
  const policy = resolverSelectionPolicy(rt.network)
  const scanned = await fetchSipaResolverOperators(
    rt.l1 as never,
    accountMetadataRegistry as Address,
    await deploymentScanRange(rt.l1, rt.tuple),
  )
  try {
    return selectManifestResolverOperator(scanned, { portal, resolverGatewayUrl, ...policy })
  } catch (err) {
    if (!policy.preferredOwner) throw err
    const direct = await readResolverOperator(
      rt.l1 as never,
      accountMetadataRegistry as Address,
      PREFERRED_RESOLVER_OWNER,
    ).catch(() => undefined)
    if (!direct || direct.url.length === 0) throw err
    const record: SipaResolverOperatorRecord = {
      owner: PREFERRED_RESOLVER_OWNER,
      l2Address: direct.l2Address as Hex,
      url: direct.url,
      oxidePortal: direct.oxidePortal as Address,
      resolverPublicKey: direct.publicKey,
    }
    const chosen = selectManifestResolverOperator([record], {
      portal,
      resolverGatewayUrl,
      ...policy,
    })
    if (process.env.ZKMONEY_DEBUG)
      note("note: resolver operator read directly; the event scan found none")
    return chosen
  }
}
