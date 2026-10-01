/**
 * Local records of what the CLI has done, keyed by the caller's idempotency key. A retry with the
 * same key returns the earlier result instead of acting twice; a key reused with different
 * arguments is refused. Kept in the same file store as the front-core stores.
 */
import type { IStorageAdapter } from "../frontCore.ts"
import { fail } from "../output.ts"

const PREFIX = "zkmoney.records/v1/"

export interface OperationRecord<T = unknown> {
  kind: string
  key: string
  /** A stable digest of the arguments, so a reused key with other arguments is caught. */
  args: string
  createdAt: number
  /** Set once the operation completed; absent while it is in flight or failed before a result. */
  result?: T
  /** The last failure, kept so a retry can say what went wrong before. */
  error?: string
}

export class Records {
  constructor(private readonly storage: IStorageAdapter) {}

  async get<T>(kind: string, key: string): Promise<OperationRecord<T> | undefined> {
    const raw = await this.storage.getItem(PREFIX + kind + "/" + key)
    return raw ? (JSON.parse(raw) as OperationRecord<T>) : undefined
  }

  async put<T>(record: OperationRecord<T>): Promise<void> {
    await this.storage.setItem(PREFIX + record.kind + "/" + record.key, JSON.stringify(record))
  }

  async list<T>(kind: string): Promise<OperationRecord<T>[]> {
    const keys = (this.storage as { keys?: () => string[] }).keys?.() ?? []
    const out: OperationRecord<T>[] = []
    for (const k of keys) {
      if (!k.startsWith(PREFIX + kind + "/")) continue
      const raw = await this.storage.getItem(k)
      if (raw) out.push(JSON.parse(raw) as OperationRecord<T>)
    }
    return out.sort((a, b) => b.createdAt - a.createdAt)
  }

  /**
   * Run `act` once for `key`. A completed record returns its result; a record with the same key but
   * different arguments fails; an incomplete one runs again and overwrites.
   */
  async once<T>(
    kind: string,
    key: string | undefined,
    args: unknown,
    act: () => Promise<T>,
  ): Promise<{ result: T; replayed: boolean }> {
    const digest = JSON.stringify(args)
    if (key) {
      const existing = await this.get<T>(kind, key)
      if (existing) {
        if (existing.args !== digest)
          fail(
            `idempotency key "${key}" was already used for a different ${kind}`,
            "use a new key for a new operation",
          )
        if (existing.result !== undefined) return { result: existing.result, replayed: true }
      }
    }
    const record: OperationRecord<T> = {
      kind,
      key: key ?? `auto-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      args: digest,
      createdAt: Date.now(),
    }
    await this.put(record)
    try {
      const result = await act()
      await this.put({ ...record, result })
      return { result, replayed: false }
    } catch (err) {
      await this.put({ ...record, error: err instanceof Error ? err.message : String(err) })
      throw err
    }
  }
}
