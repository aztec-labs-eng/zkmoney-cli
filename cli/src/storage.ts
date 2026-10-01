/** File-backed `IStorageAdapter` for every front-core store the CLI mounts: one JSON map, atomic writes. */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"
import type { IStorageAdapter } from "./frontCore.ts"

export class FileStorageAdapter implements IStorageAdapter {
  private map: Record<string, string>

  constructor(private readonly path: string) {
    this.map = existsSync(path)
      ? (JSON.parse(readFileSync(path, "utf8")) as Record<string, string>)
      : {}
  }

  async getItem(key: string): Promise<string | null> {
    return this.map[key] ?? null
  }

  async setItem(key: string, value: string): Promise<void> {
    this.map[key] = value
    this.flush()
  }

  async removeItem(key: string): Promise<void> {
    delete this.map[key]
    this.flush()
  }

  async clear(): Promise<void> {
    this.map = {}
    this.flush()
  }

  keys(): string[] {
    return Object.keys(this.map)
  }

  private flush(): void {
    mkdirSync(dirname(this.path), { recursive: true })
    const tmp = `${this.path}.tmp`
    writeFileSync(tmp, JSON.stringify(this.map, null, 2))
    renameSync(tmp, this.path)
  }
}
