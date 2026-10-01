/**
 * The account file: which authenticator holds the passkey, the master secret (for a key file) or
 * how to derive it (for a security key), and the identity once known. Secrets are sealed with a
 * passphrase from `ZKMONEY_PASSPHRASE` when one is set; without one the file is written readable
 * only by the user, which is what an unattended agent gets.
 */
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto"
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { Fr } from "@aztec/aztec.js/fields"
import { MSK_PRF_SALT } from "@obsidion/core/constants"
import { deriveMskFromPrfOutput } from "@obsidion/sdk"
import { type Authenticator, contextualizedPrfSalt } from "./authenticator.ts"
import {
  Fido2Authenticator,
  type Fido2Credential,
  createFido2Credential,
  listFido2Devices,
} from "./fido2.ts"
import { SoftwareAuthenticator } from "./software.ts"

export interface AccountFile {
  version: 1
  network: string
  rpId: string
  kind: "software" | "fido2"
  createdAt: string
  /** Sealed or plain secrets: hex private key and master secret for a key file. */
  software?: { privateKey: string; masterSecret: string; sealed?: Sealed }
  fido2?: Fido2Credential
  /** Filled in once the account has been derived or registered. */
  identity?: {
    l2Address: string
    l1Account?: string
    tag?: string
  }
}

interface Sealed {
  salt: string
  iv: string
  tag: string
  data: string
}

export const accountPath = (home: string, network: string) => join(home, network, "account.json")

function seal(plain: string, passphrase: string): Sealed {
  const salt = randomBytes(16)
  const key = scryptSync(passphrase, salt, 32)
  const iv = randomBytes(12)
  const cipher = createCipheriv("aes-256-gcm", key, iv)
  const data = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()])
  return {
    salt: salt.toString("hex"),
    iv: iv.toString("hex"),
    tag: cipher.getAuthTag().toString("hex"),
    data: data.toString("hex"),
  }
}

function unseal(sealed: Sealed, passphrase: string): string {
  const key = scryptSync(passphrase, Buffer.from(sealed.salt, "hex"), 32)
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(sealed.iv, "hex"))
  decipher.setAuthTag(Buffer.from(sealed.tag, "hex"))
  return Buffer.concat([
    decipher.update(Buffer.from(sealed.data, "hex")),
    decipher.final(),
  ]).toString("utf8")
}

export function readAccountFile(home: string, network: string): AccountFile | undefined {
  const path = accountPath(home, network)
  if (!existsSync(path)) return undefined
  return JSON.parse(readFileSync(path, "utf8")) as AccountFile
}

export function writeAccountFile(home: string, network: string, file: AccountFile): void {
  const path = accountPath(home, network)
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  const tmp = `${path}.tmp`
  writeFileSync(tmp, JSON.stringify(file, null, 2) + "\n", { mode: 0o600 })
  renameSync(tmp, path)
  chmodSync(path, 0o600)
}

const passphrase = () => process.env.ZKMONEY_PASSPHRASE

export interface UnlockedAccount {
  file: AccountFile
  authenticator: Authenticator
  masterSecret: Fr
}

/** Create the account file. A security key is used when one is plugged in, unless `kind` says otherwise. */
export async function createAccountFile(opts: {
  home: string
  network: string
  rpId: string
  kind?: "software" | "fido2" | "auto"
  userName: string
}): Promise<{ file: AccountFile; chosen: "software" | "fido2"; reason: string }> {
  const kind = opts.kind ?? "auto"
  const devices = kind === "software" ? [] : await listFido2Devices()
  if (kind === "fido2" && devices.length === 0) {
    throw new Error(
      "no FIDO2 security key found; plug one in, or install libfido2's tools (fido2-token) if they are missing",
    )
  }
  const now = new Date().toISOString()
  if (devices.length > 0) {
    const credential = await createFido2Credential(devices[0]!.path, opts.rpId, opts.userName)
    const file: AccountFile = {
      version: 1,
      network: opts.network,
      rpId: opts.rpId,
      kind: "fido2",
      createdAt: now,
      fido2: credential,
    }
    writeAccountFile(opts.home, opts.network, file)
    return { file, chosen: "fido2", reason: `security key ${devices[0]!.label}` }
  }
  const key = SoftwareAuthenticator.generate(opts.rpId)
  const secrets = {
    privateKey: Buffer.from(key.privateKey).toString("hex"),
    masterSecret: Fr.random().toString(),
  }
  const pass = passphrase()
  const file: AccountFile = {
    version: 1,
    network: opts.network,
    rpId: opts.rpId,
    kind: "software",
    createdAt: now,
    software: pass
      ? { privateKey: "", masterSecret: "", sealed: seal(JSON.stringify(secrets), pass) }
      : secrets,
  }
  writeAccountFile(opts.home, opts.network, file)
  const reason =
    kind === "auto" ? "no security key found, so a key file was made" : "key file requested"
  return {
    file,
    chosen: "software",
    reason: pass
      ? `${reason}; sealed with ZKMONEY_PASSPHRASE`
      : `${reason}; unsealed, readable only by you`,
  }
}

/** Open the account file and rebuild its authenticator and master secret. A security key asserts once for the PRF. */
export async function unlockAccount(home: string, network: string): Promise<UnlockedAccount> {
  const file = readAccountFile(home, network)
  if (!file)
    throw new Error(`no account for ${network} under ${home}; run "zkmoney account init" first`)
  if (file.kind === "fido2") {
    if (!file.fido2)
      throw new Error("the account file names a security key but holds no credential")
    const authenticator = new Fido2Authenticator(file.fido2, process.env.ZKMONEY_FIDO2_UV === "1")
    const prf = await authenticator.prf(contextualizedPrfSalt(MSK_PRF_SALT))
    return { file, authenticator, masterSecret: deriveMskFromPrfOutput(prf) }
  }
  if (!file.software) throw new Error("the account file names a key file but holds no key")
  let secrets = file.software
  if (file.software.sealed) {
    const pass = passphrase()
    if (!pass) throw new Error("the account is sealed; set ZKMONEY_PASSPHRASE to open it")
    try {
      secrets = JSON.parse(unseal(file.software.sealed, pass))
    } catch {
      throw new Error("ZKMONEY_PASSPHRASE does not open this account")
    }
  }
  const authenticator = new SoftwareAuthenticator(
    new Uint8Array(Buffer.from(secrets.privateKey, "hex")),
    file.rpId,
  )
  return { file, authenticator, masterSecret: Fr.fromString(secrets.masterSecret) }
}

export function rememberIdentity(
  home: string,
  network: string,
  identity: NonNullable<AccountFile["identity"]>,
): void {
  const file = readAccountFile(home, network)
  if (!file) return
  writeAccountFile(home, network, { ...file, identity: { ...file.identity, ...identity } })
}
