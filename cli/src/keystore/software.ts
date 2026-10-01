/** A P-256 key file standing in for a passkey: signs the exact witness a security key would. */
import { randomBytes } from "node:crypto"
import { p256 } from "@noble/curves/p256"
import { type Authenticator, base64url, clientDataJSON, sha256 } from "./authenticator.ts"
import type { WebAuthnSignResult } from "@obsidion/sdk"

/** The fixed 37-byte header: rpIdHash ‖ flags (UP|UV) ‖ counter. */
function authenticatorData(rpId: string): Uint8Array {
  const out = new Uint8Array(37)
  out.set(sha256(new TextEncoder().encode(rpId)), 0)
  out[32] = 0x05
  return out
}

export class SoftwareAuthenticator implements Authenticator {
  readonly kind = "software" as const
  readonly pubkeyX: Buffer
  readonly pubkeyY: Buffer
  readonly credentialId: string

  constructor(
    readonly privateKey: Uint8Array,
    readonly rpId: string,
    credentialId?: string,
  ) {
    const uncompressed = p256.getPublicKey(privateKey, false)
    this.pubkeyX = Buffer.from(uncompressed.subarray(1, 33))
    this.pubkeyY = Buffer.from(uncompressed.subarray(33, 65))
    this.credentialId = credentialId ?? base64url(sha256(uncompressed).subarray(0, 16))
  }

  static generate(rpId: string): SoftwareAuthenticator {
    return new SoftwareAuthenticator(new Uint8Array(randomBytes(32)), rpId)
  }

  get pubkeyHex(): string {
    return Buffer.concat([this.pubkeyX, this.pubkeyY]).toString("hex")
  }

  async sign(challenge: Buffer): Promise<WebAuthnSignResult> {
    const cdj = clientDataJSON(challenge, `https://${this.rpId}`)
    const authData = authenticatorData(this.rpId)
    const signed = new Uint8Array(authData.length + 32)
    signed.set(authData, 0)
    signed.set(sha256(cdj), authData.length)
    const signature = p256.sign(sha256(signed), this.privateKey, { lowS: true }).toCompactRawBytes()
    return { signature, authenticatorData: authData, clientDataJSON: cdj }
  }
}
