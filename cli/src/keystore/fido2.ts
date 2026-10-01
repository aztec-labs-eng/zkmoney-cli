/**
 * A FIDO2 security key as the account's passkey, driven through libfido2's command-line tools
 * (`fido2-token`, `fido2-cred`, `fido2-assert`). The credential is a discoverable one for the
 * wallet's relying party with the hmac-secret extension, so it is the same kind of passkey the web
 * wallet makes on a security key: the browser can sign in to an account the CLI created, and the
 * CLI can open one the browser created, with the same master secret from the same PRF.
 */
import { execFile, spawn } from "node:child_process"
import { randomBytes } from "node:crypto"
import { promisify } from "node:util"
import { p256 } from "@noble/curves/p256"
import type { WebAuthnSignResult } from "@obsidion/sdk"
import {
  type Authenticator,
  base64url,
  clientDataJSON,
  fromBase64url,
  sha256,
} from "./authenticator.ts"

const run = promisify(execFile)

/** Run a libfido2 tool with its parameters on stdin; the tool talks to the user on the tty itself. */
function runWithInput(file: string, args: string[], input: string): Promise<{ stdout: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { stdio: ["pipe", "pipe", "inherit"] })
    let stdout = ""
    child.stdout.setEncoding("utf8")
    child.stdout.on("data", (chunk: string) => (stdout += chunk))
    child.on("error", reject)
    child.on("close", (code) =>
      code === 0 ? resolve({ stdout }) : reject(new Error(`${file} exited with code ${code}`)),
    )
    child.stdin.end(input)
  })
}

export interface Fido2Device {
  path: string
  label: string
}

/** The security keys libfido2 can see, or an empty list when the tools or a key are absent. */
export async function listFido2Devices(): Promise<Fido2Device[]> {
  try {
    const { stdout } = await run("fido2-token", ["-L"])
    return stdout
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const colon = line.indexOf(": ")
        return colon === -1
          ? { path: line, label: line }
          : { path: line.slice(0, colon), label: line.slice(colon + 2) }
      })
  } catch {
    return []
  }
}

export async function fido2ToolsInstalled(): Promise<boolean> {
  try {
    await run("fido2-token", ["-V"])
    return true
  } catch (err) {
    // `-V` prints the version and exits non-zero on some builds; a missing binary is ENOENT.
    return (err as { code?: string }).code !== "ENOENT"
  }
}

/** libfido2 prints authenticator data CBOR-wrapped as a byte string; unwrap when it did. */
function unwrapAuthData(bytes: Uint8Array): Uint8Array {
  if (bytes[0] === 0x58) return bytes.subarray(2, 2 + bytes[1]!)
  if (bytes[0] === 0x59) return bytes.subarray(4, 4 + ((bytes[2]! << 8) | bytes[3]!))
  return bytes
}

/** The P-256 public key out of attested credential data: the COSE key's x and y entries. */
function publicKeyFromAuthData(authData: Uint8Array): { x: Buffer; y: Buffer } {
  if (!(authData[32]! & 0x40))
    throw new Error("the credential's authenticator data carries no attested key")
  const credIdLen = (authData[53]! << 8) | authData[54]!
  const cose = authData.subarray(55 + credIdLen)
  const find = (label: number) => {
    // COSE EC2 labels -2 (x) and -3 (y) encode as 0x21 / 0x22, each followed by a 32-byte string (0x58 0x20).
    for (let i = 0; i + 34 < cose.length; i++) {
      if (cose[i] === label && cose[i + 1] === 0x58 && cose[i + 2] === 0x20)
        return Buffer.from(cose.subarray(i + 3, i + 35))
    }
    throw new Error("the credential's public key is not a P-256 key")
  }
  return { x: find(0x21), y: find(0x22) }
}

const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64")
const fromB64 = (text: string) => new Uint8Array(Buffer.from(text, "base64"))

export interface Fido2Credential {
  device: string
  rpId: string
  credentialId: string
  userId: string
  pubkeyX: string
  pubkeyY: string
}

/**
 * Make a discoverable hmac-secret credential on `device` for `rpId`. The key asks for its PIN and
 * a touch on the terminal. `userName` is what a browser's account picker will show for it.
 */
export async function createFido2Credential(
  device: string,
  rpId: string,
  userName: string,
): Promise<Fido2Credential> {
  const userId = randomBytes(16)
  const input = [b64(sha256(randomBytes(32))), rpId, userName, b64(userId)].join("\n") + "\n"
  const { stdout } = await runWithInput("fido2-cred", ["-M", "-r", "-h", device], input)
  // client data hash, rp id, credential format, flags, authenticator data, credential id, ...
  const lines = stdout.split("\n").map((l) => l.trim())
  const authData = unwrapAuthData(fromB64(lines[4] ?? ""))
  const credentialId = fromB64(lines[5] ?? "")
  const { x, y } = publicKeyFromAuthData(authData)
  return {
    device,
    rpId,
    credentialId: base64url(credentialId),
    userId: base64url(userId),
    pubkeyX: x.toString("hex"),
    pubkeyY: y.toString("hex"),
  }
}

/** The discoverable credentials `device` holds for `rpId`, for opening an account made elsewhere. */
export async function listFido2Credentials(
  device: string,
  rpId: string,
): Promise<{ credentialId: string; userName: string }[]> {
  const { stdout } = await run("fido2-token", ["-L", "-k", rpId, device], { maxBuffer: 1 << 20 })
  // "<index>: <credential id b64> <user name> <user id b64> <public key> <type> ..."
  return stdout
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((line) => {
      const parts = line.replace(/^\d+:\s*/, "").split(/\s+/)
      return { credentialId: base64url(fromB64(parts[0] ?? "")), userName: parts[1] ?? "" }
    })
}

export class Fido2Authenticator implements Authenticator {
  readonly kind = "fido2" as const
  readonly pubkeyX: Buffer
  readonly pubkeyY: Buffer

  constructor(
    readonly credential: Fido2Credential,
    private readonly requireUv = false,
  ) {
    this.pubkeyX = Buffer.from(credential.pubkeyX, "hex")
    this.pubkeyY = Buffer.from(credential.pubkeyY, "hex")
  }

  get credentialId(): string {
    return this.credential.credentialId
  }

  get pubkeyHex(): string {
    return this.credential.pubkeyX + this.credential.pubkeyY
  }

  private async assert(clientDataHash: Uint8Array, hmacSalt?: Uint8Array) {
    const lines = [
      b64(clientDataHash),
      this.credential.rpId,
      b64(fromBase64url(this.credential.credentialId)),
    ]
    if (hmacSalt) lines.push(b64(hmacSalt))
    const args = ["-G", "-t", "up=true"]
    if (this.requireUv) args.push("-t", "uv=true")
    if (hmacSalt) args.push("-h")
    args.push(this.credential.device)
    const { stdout } = await runWithInput("fido2-assert", args, lines.join("\n") + "\n")
    // client data hash, rp id, authenticator data, signature, hmac secret (with -h)
    const out = stdout.split("\n").map((l) => l.trim())
    return {
      authenticatorData: unwrapAuthData(fromB64(out[2] ?? "")),
      signatureDer: fromB64(out[3] ?? ""),
      hmacSecret: hmacSalt ? fromB64(out[4] ?? "") : undefined,
    }
  }

  async sign(challenge: Buffer): Promise<WebAuthnSignResult> {
    const cdj = clientDataJSON(challenge, `https://${this.credential.rpId}`)
    const { authenticatorData, signatureDer } = await this.assert(sha256(cdj))
    // The key signs in DER; the account contract wants raw r‖s with a low s.
    const signature = p256.Signature.fromDER(signatureDer).normalizeS().toCompactRawBytes()
    return { signature, authenticatorData, clientDataJSON: cdj }
  }

  async prf(salt: Uint8Array): Promise<Uint8Array> {
    const { hmacSecret } = await this.assert(
      sha256(clientDataJSON(randomBytes(32), `https://${this.credential.rpId}`)),
      salt,
    )
    if (!hmacSecret || hmacSecret.length !== 32)
      throw new Error("the security key returned no PRF output; it may lack hmac-secret")
    return hmacSecret
  }
}
