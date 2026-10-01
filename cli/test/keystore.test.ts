import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createHash } from "node:crypto"
import { p256 } from "@noble/curves/p256"
import { afterEach, describe, expect, it } from "vitest"
import { SoftwareAuthenticator } from "../src/keystore/software.ts"
import { contextualizedPrfSalt, sha256 } from "../src/keystore/authenticator.ts"
import {
  accountPath,
  createAccountFile,
  readAccountFile,
  unlockAccount,
} from "../src/keystore/keystore.ts"
import { MSK_PRF_SALT } from "@obsidion/core/constants"

const homes: string[] = []
const home = () => {
  const dir = mkdtempSync(join(tmpdir(), "zkmoney-"))
  homes.push(dir)
  return dir
}
afterEach(() => {
  for (const dir of homes.splice(0)) rmSync(dir, { recursive: true, force: true })
  delete process.env.ZKMONEY_PASSPHRASE
})

describe("software authenticator", () => {
  it("signs the WebAuthn witness the account contract verifies", async () => {
    const key = SoftwareAuthenticator.generate("auth.zk.money")
    const challenge = Buffer.from(createHash("sha256").update("challenge").digest())
    const result = await key.sign(challenge)
    expect(result.signature).toHaveLength(64)
    expect(result.authenticatorData).toHaveLength(37)
    expect(result.authenticatorData[32]).toBe(0x05)
    const cdj = JSON.parse(Buffer.from(result.clientDataJSON).toString("utf8"))
    expect(cdj.type).toBe("webauthn.get")
    expect(cdj.origin).toBe("https://auth.zk.money")
    // The contract hashes authenticatorData ‖ sha256(clientDataJSON) and checks P-256 over it.
    const signed = Buffer.concat([result.authenticatorData, sha256(result.clientDataJSON)])
    const pub = Buffer.concat([Buffer.from([4]), key.pubkeyX, key.pubkeyY])
    expect(p256.verify(result.signature, sha256(signed), pub)).toBe(true)
  })

  it("derives a stable credential id from the key", () => {
    const key = SoftwareAuthenticator.generate("auth.zk.money")
    const again = new SoftwareAuthenticator(key.privateKey, "auth.zk.money")
    expect(again.credentialId).toBe(key.credentialId)
    expect(again.pubkeyHex).toBe(key.pubkeyHex)
  })
})

describe("PRF salt contextualization", () => {
  it("matches the wallet's second slot for the canonical salt", () => {
    // The value the web wallet derives for `prfSecondSalt`, pinned in this session against
    // @obsidion/passkey-web's `prfSalts()`.
    expect(Buffer.from(contextualizedPrfSalt(MSK_PRF_SALT)).toString("hex")).toBe(
      "f3b0ab00f476a660bca5ad4dcd937f5231a82ba7959cfc660c51e09fe5fb063a",
    )
  })
})

describe("account file", () => {
  it("creates a key file account and reopens it", async () => {
    const dir = home()
    const { chosen } = await createAccountFile({
      home: dir,
      network: "sandbox",
      rpId: "localhost",
      kind: "software",
      userName: "t",
    })
    expect(chosen).toBe("software")
    expect(statSync(accountPath(dir, "sandbox")).mode & 0o777).toBe(0o600)
    const unlocked = await unlockAccount(dir, "sandbox")
    expect(unlocked.authenticator.kind).toBe("software")
    expect(unlocked.masterSecret.toString()).toMatch(/^0x[0-9a-f]{64}$/)
  })

  it("seals the secrets under ZKMONEY_PASSPHRASE and refuses the wrong one", async () => {
    const dir = home()
    process.env.ZKMONEY_PASSPHRASE = "correct horse"
    await createAccountFile({
      home: dir,
      network: "sandbox",
      rpId: "localhost",
      kind: "software",
      userName: "t",
    })
    const raw = readFileSync(accountPath(dir, "sandbox"), "utf8")
    expect(raw).not.toContain('privateKey": "0')
    expect(readAccountFile(dir, "sandbox")?.software?.sealed).toBeDefined()
    const unlocked = await unlockAccount(dir, "sandbox")
    expect(unlocked.authenticator.kind).toBe("software")
    process.env.ZKMONEY_PASSPHRASE = "wrong"
    await expect(unlockAccount(dir, "sandbox")).rejects.toThrow(/does not open/)
  })

  it("refuses to open when no account exists", async () => {
    await expect(unlockAccount(home(), "mainnet")).rejects.toThrow(/account init/)
  })
})
