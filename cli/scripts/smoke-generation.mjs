// Spawns a v5 generation entry (an installed 0.4.1's lib/generation.mjs, or a v5 checkout's
// cli/bin/generation.mjs) and runs the calls that need no node: the handshake and the account
// address derivation from throwaway keys against the v5 profile's contracts.
//
//   node scripts/smoke-generation.mjs <entry> <v5 profile url>
import { spawn } from "node:child_process"
import { generateKeyPairSync, randomBytes } from "node:crypto"
import { createInterface } from "node:readline"

const [entry, profileUrl] = process.argv.slice(2)
if (!entry || !profileUrl) throw new Error("usage: smoke-generation.mjs <entry> <profile url>")
const child = spawn(process.execPath, [entry], { stdio: ["pipe", "pipe", "inherit"] })
const pending = new Map()
let next = 1
createInterface({ input: child.stdout }).on("line", (line) => {
  const message = JSON.parse(line)
  if (message.kind === "call") throw new Error(`unexpected callback ${message.method}`)
  const waiting = pending.get(message.id)
  pending.delete(message.id)
  if (message.kind === "result") waiting.resolve(message.result)
  else waiting.reject(new Error(message.message))
})
const call = (method, params) =>
  new Promise((resolve, reject) => {
    const id = next++
    pending.set(id, { resolve, reject })
    child.stdin.write(JSON.stringify({ kind: "call", id, method, params }) + "\n")
  })

const started = Date.now()
console.log("hello:", await call("hello"))
const profile = await (await fetch(profileUrl)).json()
const version = profile.versions[profile.current]
// A leading zero byte keeps the secret under the field modulus.
const secretKey = `0x00${randomBytes(31).toString("hex")}`
const jwk = generateKeyPairSync("ec", { namedCurve: "P-256" }).publicKey.export({ format: "jwk" })
const publicKeyHex = Buffer.concat([
  Buffer.from(jwk.x, "base64url"),
  Buffer.from(jwk.y, "base64url"),
]).toString("hex")
const contracts = { network: profile.network, contracts: version.contracts }
console.log(
  "accountAddress:",
  await call("accountAddress", { secretKey, publicKeyHex, network: profile.network, contracts }),
)
console.log("no session yet:", await call("session.balance", {}).catch((e) => e.message))
console.log(`done in ${Date.now() - started} ms`)
child.stdin.end()
