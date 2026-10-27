/** The attested co-signer for oxide-token batches, loaded once per process for services other than the TokenService. */
import { createOxideTeeSignerSource } from "../frontCore.ts"
import type { RegisteredTeeSigner } from "@obsidion/sdk"
import { fail } from "../output.ts"
import type { Runtime } from "./boot.ts"

const signers = new WeakMap<Runtime, Promise<RegisteredTeeSigner | undefined>>()

export function teeSignerFor(rt: Runtime): Promise<RegisteredTeeSigner | undefined> {
  let signer = signers.get(rt)
  if (!signer) {
    signer = createOxideTeeSignerSource({
      l1RpcUrl: rt.config.l1RpcUrl.value,
      l1Chain: rt.l1Chain,
      getTuple: () => rt.tuple,
    }).load()
    signers.set(rt, signer)
  }
  return signer
}

export async function requireTeeSigner(rt: Runtime): Promise<RegisteredTeeSigner> {
  const signer = await teeSignerFor(rt)
  if (!signer)
    fail(
      "the attested co-signer is not reachable, so no token batch can be attested",
      "check the enclave URL in the oxide manifest and your connection",
    )
  return signer
}
