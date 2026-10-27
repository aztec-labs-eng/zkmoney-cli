/**
 * One JSON object per line, both ways, between this process and a source generation's. Either side
 * calls the other: the host calls the generation's methods, the generation calls back for a
 * signature or a read only the host can make. Only plain data crosses: bytes as hex, amounts as
 * decimal strings, functions as callback ids the host keeps.
 */
import { createInterface } from "node:readline"

export type RpcParams = unknown
type Call = { kind: "call"; id: number; method: string; params: RpcParams }
type Result = { kind: "result"; id: number; result: unknown }
type Failure = { kind: "error"; id: number; message: string }
type Message = Call | Result | Failure

export type RpcHandler = (params: RpcParams) => Promise<unknown>

export class RpcError extends Error {}

export class RpcPeer {
  private nextId = 1
  private readonly pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (err: Error) => void }
  >()
  private readonly handlers = new Map<string, RpcHandler>()
  private closed: Error | undefined

  constructor(
    input: NodeJS.ReadableStream,
    private readonly output: NodeJS.WritableStream,
  ) {
    const lines = createInterface({ input, crlfDelay: Infinity })
    lines.on("line", (line) => this.receive(line))
    lines.on("close", () => this.close(new RpcError("the other side closed the connection")))
  }

  handle(method: string, handler: RpcHandler): void {
    this.handlers.set(method, handler)
  }

  call<T = unknown>(method: string, params: RpcParams = undefined): Promise<T> {
    if (this.closed) return Promise.reject(this.closed)
    const id = this.nextId++
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject })
      this.send({ kind: "call", id, method, params })
    })
  }

  /** Fails every call still waiting; later calls fail at once. */
  close(reason: Error): void {
    if (this.closed) return
    this.closed = reason
    for (const { reject } of this.pending.values()) reject(reason)
    this.pending.clear()
  }

  private send(message: Message): void {
    this.output.write(JSON.stringify(message) + "\n")
  }

  private receive(line: string): void {
    if (!line.trim()) return
    let message: Message
    try {
      message = JSON.parse(line) as Message
    } catch {
      return
    }
    if (message.kind === "call") {
      void this.serve(message)
      return
    }
    const waiting = this.pending.get(message.id)
    if (!waiting) return
    this.pending.delete(message.id)
    if (message.kind === "result") waiting.resolve(message.result)
    else waiting.reject(new RpcError(message.message))
  }

  private async serve(call: Call): Promise<void> {
    const handler = this.handlers.get(call.method)
    try {
      if (!handler) throw new Error(`unknown method ${call.method}`)
      this.send({ kind: "result", id: call.id, result: await handler(call.params) })
    } catch (err) {
      this.send({
        kind: "error",
        id: call.id,
        message: err instanceof Error ? err.message : String(err),
      })
    }
  }
}

export const toHex = (bytes: Uint8Array): string => `0x${Buffer.from(bytes).toString("hex")}`

export function fromHex(value: unknown, name: string): Buffer {
  if (typeof value !== "string" || !/^0x(?:[0-9a-fA-F]{2})*$/.test(value))
    throw new Error(`${name} is not hex`)
  return Buffer.from(value.slice(2), "hex")
}
