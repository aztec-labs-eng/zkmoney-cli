/**
 * The Aztec v5 source generation: the v5 build of this CLI, run as a child process that speaks the
 * wallet's source-generation protocol over its stdio. One process serves one source node for the
 * command's lifetime; it opens the v5 PXE this CLI kept for the old network, and every passkey
 * prompt it needs comes back here, where the account's authenticator signs.
 */
import { spawn, type ChildProcess } from "node:child_process"
import { existsSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import {
  SOURCE_GENERATION_PROTOCOL,
  type SourceGenerationOpenParams,
  type SourceGenerationSession,
  type SourceRefundRuntime,
} from "@obsidion/core/types"
import type { WebAuthnSignResult } from "@obsidion/sdk"
import { fail, note } from "../../output.ts"
import { RpcPeer, fromHex, toHex } from "./rpc.ts"

/** The v5 release the generation is taken from. */
export const GENERATION_V5_VERSION = "0.4.1"
const REPO = "aztec-labs-eng/zkmoney-cli"

export type SourceSign = (challenge: Uint8Array) => Promise<WebAuthnSignResult>

/** Where the v5 build lives: a setting or env, else the default install. */
export function generationV5Dir(configured: string | undefined): string {
  return (
    configured ??
    process.env.ZKMONEY_GENERATION_V5 ??
    join(process.env.ZKMONEY_INSTALL_DIR ?? join(homedir(), ".local/share"), "zkmoney-cli-v5")
  )
}

/** The generation's entry in `dir`: an installed v5 release, or a v5 source checkout. */
function generationEntry(dir: string): string | undefined {
  for (const entry of ["lib/generation.mjs", "cli/bin/generation.mjs", "bin/generation.mjs"]) {
    const path = join(dir, entry)
    if (existsSync(path)) return path
  }
  return undefined
}

/** Installs the v5 release into `dir` with the GitHub CLI, as `install.sh` does for this one. */
async function installGenerationV5(dir: string): Promise<void> {
  note(`installing the v5 CLI ${GENERATION_V5_VERSION} into ${dir} to read the old network`)
  const script = `gh release download -R ${REPO} -p install.sh -O - | sh -s -- ${GENERATION_V5_VERSION}`
  await new Promise<void>((resolve, reject) => {
    const child = spawn("sh", ["-c", script], {
      stdio: ["ignore", "inherit", "inherit"],
      env: { ...process.env, ZKMONEY_INSTALL_DIR: dir, ZKMONEY_BIN_DIR: join(dir, "bin-links") },
    })
    child.on("error", reject)
    child.on("exit", (code) =>
      code === 0 ? resolve() : reject(new Error(`the install exited with ${code}`)),
    )
  })
}

export interface GenerationProcess {
  /** The account's L2 address on the v5 rollup, from its keys alone. */
  accountAddress(o: {
    secretKey: string
    publicKeyHex: string
    network: string
    contracts: unknown
  }): Promise<string>
  open(
    params: SourceGenerationOpenParams & { pxeDataDirectory: string },
  ): Promise<GenerationSession>
  /**
   * Runs `step` with every passkey prompt the generation raises going through `wrap`, as the web
   * wallet's `withSourceSigner` does: a refund's prompts are saved as approvals, so a retry never
   * asks twice.
   */
  withSigner<T>(wrap: (sign: SourceSign) => SourceSign, step: () => Promise<T>): Promise<T>
  close(): void
}

export type GenerationSession = SourceGenerationSession

/** Starts the v5 generation, installing it first when it is not there. `sign` answers its prompts. */
export async function startGenerationV5(dir: string, sign: SourceSign): Promise<GenerationProcess> {
  let entry = generationEntry(dir)
  if (!entry) {
    await installGenerationV5(dir)
    entry = generationEntry(dir)
    if (!entry) fail(`the v5 CLI did not install into ${dir}`, "set ZKMONEY_GENERATION_V5 to one")
  }
  const child: ChildProcess = spawn(process.execPath, [entry], {
    stdio: ["pipe", "pipe", "inherit"],
    env: { ...process.env, LOG_LEVEL: process.env.ZKMONEY_DEBUG ? process.env.LOG_LEVEL : "error" },
  })
  const peer = new RpcPeer(child.stdout!, child.stdin!)
  child.on("exit", (code, signal) =>
    peer.close(new Error(`the v5 generation exited (${signal ?? code})`)),
  )
  let signThrough: ((sign: SourceSign) => SourceSign) | undefined
  let signerTurn: Promise<unknown> = Promise.resolve()
  peer.handle("sign", async (params) => {
    const { challenge } = params as { challenge: string }
    const signer = signThrough?.(sign) ?? sign
    const result = await signer(fromHex(challenge, "challenge"))
    return {
      authenticatorData: toHex(result.authenticatorData),
      clientDataJSON: toHex(result.clientDataJSON),
      signature: toHex(result.signature),
    }
  })
  // Reads only the host can make, handed to the generation as callback ids.
  const callbacks = new Map<number, (...args: unknown[]) => Promise<unknown>>()
  let nextCallback = 1
  peer.handle("callback", async (params) => {
    const { id, args } = params as { id: number; args: unknown[] }
    const callback = callbacks.get(id)
    if (!callback) throw new Error(`unknown callback ${id}`)
    return callback(...(args ?? []))
  })
  const register = (fn: (...args: never[]) => Promise<unknown>): number => {
    const id = nextCallback++
    callbacks.set(id, fn as (...args: unknown[]) => Promise<unknown>)
    return id
  }
  const hello = await peer.call<{ protocol: number; aztecVersion: string }>("hello")
  if (hello.protocol !== SOURCE_GENERATION_PROTOCOL)
    fail(
      `the v5 CLI at ${dir} speaks source-generation protocol ${hello.protocol}, not ${SOURCE_GENERATION_PROTOCOL}`,
      `install the v5 CLI ${GENERATION_V5_VERSION} there`,
    )
  if (!hello.aztecVersion.replace(/^v/, "").startsWith("5."))
    fail(`the CLI at ${dir} is built for Aztec ${hello.aztecVersion}, not Aztec 5`)

  const runtimeProxy = (handle: number): SourceRefundRuntime => ({
    identity: "",
    validate: (asset) => peer.call("runtime.validate", { handle, asset }),
    candidates: (opts) => peer.call("runtime.candidates", { handle, opts }),
    plainExecutorCall: (recipient, relayerTip) =>
      peer.call("runtime.plainExecutorCall", { handle, recipient, relayerTip }),
    build: (selection, executorCall) =>
      peer.call("runtime.build", { handle, selection, executorCall }),
    refunded: (ids) => peer.call("runtime.refunded", { handle, ids }),
  })

  const sessionProxy = (): GenerationSession & { address: string; rollupAddress: string } => {
    let address = ""
    let rollupAddress = ""
    const session: GenerationSession = {
      get address() {
        return address
      },
      get rollupAddress() {
        return rollupAddress
      },
      balance: (o) => peer.call("session.balance", o),
      sipaSources: (o) => peer.call("session.sipaSources", o),
      history: (o) => peer.call("session.history", o),
      savingsMoves: (o) => peer.call("session.savingsMoves", o),
      frozenSummary: ({ tuple, depositDescriptors, paylinkRows }) =>
        peer.call("session.frozenSummary", {
          tuple,
          depositDescriptors: register(depositDescriptors),
          paylinkRows: register(paylinkRows),
        }),
      refundedLinks: ({ tuple, paylinkRows }) =>
        peer.call("session.refundedLinks", { tuple, paylinkRows: register(paylinkRows) }),
      refundRuntime: async ({ tuple, tipRecipient, depositDescriptors, paylinkRows }) => {
        const { handle, identity } = await peer.call<{ handle: number; identity: string }>(
          "session.refundRuntime",
          {
            tuple,
            tipRecipient,
            depositDescriptors: register(depositDescriptors),
            paylinkRows: register(paylinkRows),
          },
        )
        return { ...runtimeProxy(handle), identity }
      },
    }
    return Object.assign(session, {
      set address(value: string) {
        address = value
      },
      set rollupAddress(value: string) {
        rollupAddress = value
      },
    }) as GenerationSession & { address: string; rollupAddress: string }
  }

  return {
    accountAddress: (o) => peer.call("accountAddress", o),
    async open(params) {
      const opened = await peer.call<{ address: string; rollupAddress: string }>("open", {
        ...params,
        account: { secretKey: params.account.secretKey, passkey: params.account.passkey.publicKey },
      })
      const session = sessionProxy()
      session.address = opened.address
      session.rollupAddress = opened.rollupAddress
      return session
    },
    withSigner(wrap, step) {
      const run = signerTurn.then(async () => {
        signThrough = wrap
        try {
          return await step()
        } finally {
          signThrough = undefined
        }
      })
      signerTurn = run.catch(() => {})
      return run
    },
    close() {
      peer.close(new Error("the v5 generation was closed"))
      child.kill()
    },
  }
}
