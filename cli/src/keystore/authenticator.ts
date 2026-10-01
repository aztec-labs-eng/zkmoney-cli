/**
 * What signs for the account. The production account contract verifies a P-256 signature over
 * `authenticatorData ‖ sha256(clientDataJSON)` and checks only the challenge inside the client
 * data, so any P-256 holder that can produce that shape is a valid passkey for it: a FIDO2 security
 * key through libfido2 (the same credential a browser would use, PRF included), or a key file.
 */
import { createHash } from "node:crypto"
import { WebAuthnAlphaAuthProvider, type WebAuthnSignResult } from "@obsidion/sdk"

export type AuthenticatorKind = "fido2" | "software"

export interface Authenticator {
  readonly kind: AuthenticatorKind
  /** 64-byte x‖y hex, the shape the SDK derives the account address from. */
  readonly pubkeyHex: string
  readonly pubkeyX: Buffer
  readonly pubkeyY: Buffer
  /** Base64url credential id; a security key's own, a synthetic one for a key file. */
  readonly credentialId: string
  sign(challenge: Buffer): Promise<WebAuthnSignResult>
  /** The WebAuthn PRF output for `salt`, where the authenticator supports it. */
  prf?(salt: Uint8Array): Promise<Uint8Array>
}

export const sha256 = (data: Uint8Array): Uint8Array =>
  new Uint8Array(createHash("sha256").update(data).digest())

export const base64url = (bytes: Uint8Array): string =>
  Buffer.from(bytes).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")

export const fromBase64url = (text: string): Uint8Array =>
  new Uint8Array(Buffer.from(text.replace(/-/g, "+").replace(/_/g, "/"), "base64"))

/** The client data a browser would send for an assertion with this challenge. */
export function clientDataJSON(challenge: Uint8Array, origin: string): Uint8Array {
  return new TextEncoder().encode(
    `{"type":"webauthn.get","challenge":"${base64url(
      challenge,
    )}","origin":"${origin}","crossOrigin":false}`,
  )
}

export function providerFor(authenticator: Authenticator): WebAuthnAlphaAuthProvider {
  return new WebAuthnAlphaAuthProvider(authenticator.pubkeyX, authenticator.pubkeyY, (challenge) =>
    authenticator.sign(challenge),
  )
}

/**
 * The salt a browser hands a security key for the wallet's canonical PRF salt: WebAuthn's
 * contextualization `SHA-256("WebAuthn PRF" ‖ 0x00 ‖ salt)`. A key asserted here with this salt
 * returns the same PRF output the web wallet gets from it, so the master secret, and therefore the
 * account, is the same.
 */
export function contextualizedPrfSalt(canonical: Uint8Array): Uint8Array {
  const prefix = new TextEncoder().encode("WebAuthn PRF")
  const buf = new Uint8Array(prefix.length + 1 + canonical.length)
  buf.set(prefix, 0)
  buf[prefix.length] = 0
  buf.set(canonical, prefix.length + 1)
  return sha256(buf)
}
