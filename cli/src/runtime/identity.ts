/** The account's addresses on both layers, and whether its L1 account holds a name. */
import type { Hex } from "viem"
import {
  createOxideL1Reader,
  deriveBootstrapKey,
  resolveOxideAccountFactory,
} from "../frontCore.ts"
import { readNameOf } from "@oxide/l1-contracts"
import { isAllZeroHex } from "@obsidion/core/oxide"
import type { Runtime } from "./boot.ts"

export interface Identity {
  l2Address: string
  l1Account: string
  /** The tag as stored locally; the registry holds only its hash. */
  tag?: string
  registered: boolean
}

export async function readIdentity(rt: Runtime): Promise<Identity> {
  const { unlocked, account } = await rt.account()
  const bootstrap = deriveBootstrapKey(unlocked.masterSecret)
  const factory = resolveOxideAccountFactory({ tuple: rt.tuple })
  const l1Account = await createOxideL1Reader(rt.l1).predictAccountAddress(
    factory,
    bootstrap.address,
  )
  let registered = false
  if (rt.tuple.registry) {
    const nameHash = await readNameOf(rt.l1 as never, rt.tuple.registry as Hex, l1Account as Hex)
    registered = !isAllZeroHex(nameHash)
  }
  return {
    l2Address: account.getAddress().toString(),
    l1Account,
    tag: unlocked.file.identity?.tag,
    registered,
  }
}
