/**
 * The ways out of an oxide escrow that holds funds nobody moved on: anyone with gas can run it, and its
 * recovery account, this account's OxideAccount, can send what it holds to any Ethereum address.
 */
import { randomBytes } from "node:crypto"
import { escrowERC20RecoveryDigest } from "@oxide/l1-contracts"
import { createWalletClient, http, type Address, type Hex } from "viem"
import { privateKeyToAccount } from "viem/accounts"
import {
  createOxideL1Reader,
  deriveBootstrapKey,
  resolveOxideAccountFactory,
  signAccountDigest,
} from "../frontCore.ts"
import { fail } from "../output.ts"
import type { Runtime } from "./boot.ts"
import { oxideAccountPasskey, registrationKeysOf } from "./registration.ts"
import { keysOf } from "./sponsor.ts"

export interface L1Call {
  to: Address
  data: Hex
}

/** The L1 account whose signature recovers this account's escrows: its OxideAccount. */
export async function recoveryAccountOf(rt: Runtime): Promise<Address> {
  const keys = await keysOf(rt)
  return (await createOxideL1Reader(rt.l1).predictAccountAddress(
    resolveOxideAccountFactory({ tuple: rt.tuple }),
    deriveBootstrapKey(keys.secretKey).address,
  )) as Address
}

/** Sends each call from `privateKey`, which pays its gas, and waits for it to succeed. */
export function l1Sender(rt: Runtime, privateKey: Hex): (call: L1Call) => Promise<Hex> {
  const wallet = createWalletClient({
    account: privateKeyToAccount(privateKey),
    chain: rt.l1Chain,
    transport: http(rt.config.l1RpcUrl.value, { timeout: 20_000 }),
  })
  return async (call) => {
    const hash = await wallet.sendTransaction({ to: call.to, data: call.data })
    const receipt = await rt.l1.waitForTransactionReceipt({ hash })
    if (receipt.status !== "success") fail(`transaction ${hash} reverted`)
    return hash
  }
}

/** One token's `recoverERC20`, signed. An escrow that never ran has no code, so `deployed` says whether to deploy it. */
export interface SignedRecovery {
  deployed: boolean
  signature: Hex
  token: Address
  nonce: Hex
  /** Unix seconds after which the escrow refuses the signature. */
  deadline: bigint
}

/** How long a recovery signature stays valid, in chain seconds: it is sent at once. */
const RECOVERY_DEADLINE_S = 60n * 60n

/**
 * Sends what `escrow` holds of each token to `to`, one signed recovery per token. `call` builds each
 * recovery's transaction.
 */
export async function recoverEscrowTokens(
  rt: Runtime,
  input: {
    escrow: Address
    account: Address
    to: Address
    holdings: (readonly [Address, bigint])[]
  },
  call: (recovery: SignedRecovery) => L1Call,
  send: (call: L1Call) => Promise<Hex>,
): Promise<Hex[]> {
  const keys = await registrationKeysOf(rt)
  const signing = {
    account: input.account,
    chainId: rt.config.l1ChainId,
    reader: createOxideL1Reader(rt.l1),
    passkey: await oxideAccountPasskey(keys.provider),
    bootstrap: deriveBootstrapKey(keys.secretKey),
  }
  const txHashes: Hex[] = []
  for (const [token, amount] of input.holdings) {
    if (amount === 0n) continue
    const nonce = `0x${randomBytes(32).toString("hex")}` as Hex
    const deadline = (await rt.l1.getBlock({ blockTag: "latest" })).timestamp + RECOVERY_DEADLINE_S
    const hash = escrowERC20RecoveryDigest(
      input.escrow,
      BigInt(rt.config.l1ChainId),
      input.to,
      token,
      nonce,
      deadline,
    )
    // The first recovery deploys an escrow that never ran, so each one checks again.
    const code = await rt.l1.getCode({ address: input.escrow })
    const signature = await signAccountDigest({ ...signing, hash })
    txHashes.push(
      await send(call({ deployed: !!code && code !== "0x", signature, token, nonce, deadline })),
    )
  }
  return txHashes
}
