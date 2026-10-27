/**
 * The generation's side of the stdio protocol: each method the host calls maps to the v5 session,
 * and the reads only the host can make come back as callbacks the host numbered.
 */
import { SOURCE_GENERATION_PROTOCOL, type SourceRefundRuntime } from "./protocol.ts"
import { RpcPeer, fromHex } from "./rpc.ts"
import { accountAddress, aztecVersion, open, type V5OpenParams, type V5Session } from "./v5.ts"

export async function serveGeneration(): Promise<void> {
  const peer = new RpcPeer(process.stdin, process.stdout)
  const callback =
    (id: number) =>
    (...args: unknown[]) =>
      peer.call("callback", { id, args })
  let session: V5Session | undefined
  const runtimes = new Map<number, SourceRefundRuntime>()
  let nextRuntime = 1
  const opened = (): V5Session => {
    if (!session) throw new Error("no session is open")
    return session
  }
  const runtime = (handle: number): SourceRefundRuntime => {
    const found = runtimes.get(handle)
    if (!found) throw new Error(`no refund runtime ${handle}`)
    return found
  }

  peer.handle("hello", async () => ({ protocol: SOURCE_GENERATION_PROTOCOL, aztecVersion }))
  peer.handle("accountAddress", (params) => accountAddress(params as never))
  peer.handle("open", async (params) => {
    const p = params as Omit<V5OpenParams, "sign">
    session = await open({
      ...p,
      sign: async (challenge) => {
        const result = (await peer.call("sign", {
          challenge: `0x${challenge.toString("hex")}`,
        })) as {
          authenticatorData: string
          clientDataJSON: string
          signature: string
        }
        return {
          authenticatorData: new Uint8Array(fromHex(result.authenticatorData, "authenticatorData")),
          clientDataJSON: new Uint8Array(fromHex(result.clientDataJSON, "clientDataJSON")),
          signature: new Uint8Array(fromHex(result.signature, "signature")),
        }
      },
    })
    return { address: session.address, rollupAddress: session.rollupAddress }
  })
  peer.handle("session.balance", (params) => opened().balance(params as never))
  peer.handle("session.sipaSources", (params) => opened().sipaSources(params as never))
  peer.handle("session.savingsMoves", (params) => opened().savingsMoves(params as never))
  peer.handle("session.history", async () => {
    throw new Error("the v5 generation does not replay history for the CLI")
  })
  peer.handle("session.frozenSummary", (params) => {
    const p = params as { tuple: never; depositDescriptors: number; paylinkRows: number }
    return opened().frozenSummary({
      tuple: p.tuple,
      depositDescriptors: callback(p.depositDescriptors) as never,
      paylinkRows: callback(p.paylinkRows) as never,
    })
  })
  peer.handle("session.refundedLinks", (params) => {
    const p = params as { tuple: never; paylinkRows: number }
    return opened().refundedLinks({ tuple: p.tuple, paylinkRows: callback(p.paylinkRows) as never })
  })
  peer.handle("session.refundRuntime", async (params) => {
    const p = params as {
      tuple: never
      tipRecipient: string
      depositDescriptors: number
      paylinkRows: number
    }
    const built = await opened().refundRuntime({
      tuple: p.tuple,
      tipRecipient: p.tipRecipient,
      depositDescriptors: callback(p.depositDescriptors) as never,
      paylinkRows: callback(p.paylinkRows) as never,
    })
    const handle = nextRuntime++
    runtimes.set(handle, built)
    return { handle, identity: built.identity }
  })
  peer.handle("runtime.validate", (params) => {
    const p = params as { handle: number; asset: string }
    return runtime(p.handle).validate(p.asset)
  })
  peer.handle("runtime.candidates", (params) => {
    const p = params as { handle: number; opts?: { fresh?: boolean } }
    return runtime(p.handle).candidates(p.opts)
  })
  peer.handle("runtime.plainExecutorCall", (params) => {
    const p = params as { handle: number; recipient: string; relayerTip: string }
    return runtime(p.handle).plainExecutorCall(p.recipient, p.relayerTip)
  })
  peer.handle("runtime.build", (params) => {
    const p = params as {
      handle: number
      selection: Parameters<SourceRefundRuntime["build"]>[0]
      executorCall: Parameters<SourceRefundRuntime["build"]>[1]
    }
    return runtime(p.handle).build(p.selection, p.executorCall)
  })
  peer.handle("runtime.refunded", (params) => {
    const p = params as { handle: number; ids: string[] }
    return runtime(p.handle).refunded(p.ids)
  })

  // The host's end closing the pipe ends this process.
  await new Promise<void>((resolve) => {
    process.stdin.on("end", resolve)
    process.stdin.on("close", resolve)
  })
  await session?.close().catch(() => {})
}
