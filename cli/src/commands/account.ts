import { Command } from "commander"
import { WEB_PASSKEY_RP_IDS } from "@obsidion/core/constants"
import { defaultHome, dirOf, loadConfig, networkOf, profileOf } from "../config.ts"
import {
  accountPath,
  createAccountFile,
  readAccountFile,
  rememberIdentity,
} from "../keystore/keystore.ts"
import { listFido2Devices } from "../keystore/fido2.ts"
import { fail, fields, print, shorten } from "../output.ts"
import { boot } from "../runtime/boot.ts"
import { readIdentity } from "../runtime/identity.ts"

/** The web wallet's relying party for this profile, so a security-key account is shared with it. */
export function rpIdFor(dir: string): string {
  // Production builds pass VITE_PASSKEY_RP_ID=wallet.zk.money; the constants table lags behind.
  if (dir === "mainnet") return "wallet.zk.money"
  if (dir === "testnet") return WEB_PASSKEY_RP_IDS.staging
  if (dir === "dev") return WEB_PASSKEY_RP_IDS.dev
  return WEB_PASSKEY_RP_IDS.local
}

export function accountCommand(): Command {
  const cmd = new Command("account").description("the CLI's own account: create it, show it")

  cmd
    .command("init")
    .description(
      "create the account's passkey: a plugged-in security key when there is one, else a key file",
    )
    .option("--key <kind>", "security-key | file | auto", "auto")
    .option(
      "--name <name>",
      "what a browser's passkey picker shows for a security-key credential",
      "zk.money CLI",
    )
    .action(async (opts: { key: string; name: string }, cmd: Command) => {
      const globals = cmd.optsWithGlobals<{ home?: string; profile?: string }>()
      const home = globals.home ?? defaultHome()
      const dir = dirOf(profileOf(home, globals.profile))
      if (readAccountFile(home, dir)) {
        fail(
          `an account already exists at ${accountPath(home, dir)}`,
          "move it aside to start a new one",
        )
      }
      const kind = opts.key === "security-key" ? "fido2" : opts.key === "file" ? "software" : "auto"
      const { file, chosen, reason } = await createAccountFile({
        home,
        network: dir,
        rpId: rpIdFor(dir),
        kind,
        userName: opts.name,
      })
      print(
        fields([
          ["Passkey", chosen === "fido2" ? "security key" : "key file"],
          ["Why", reason],
          ["Relying party", file.rpId],
          ["Saved to", accountPath(home, dir)],
        ]),
      )
      print(
        "\nNext: fund a tag with `zkmoney register <tag>`, or just receive with `zkmoney deposits create`.",
      )
    })

  cmd
    .command("show")
    .description("the account's addresses and passkey")
    .option("--full", "print full addresses")
    .action(async (opts: { full?: boolean }, cmd: Command) => {
      const globals = cmd.optsWithGlobals<{ home?: string; profile?: string }>()
      const home = globals.home ?? defaultHome()
      const profile = profileOf(home, globals.profile)
      const network = networkOf(profile)
      const dir = dirOf(profile)
      const file = readAccountFile(home, dir)
      if (!file) fail(`no account for ${dir} yet`, "run `zkmoney account init`")
      const devices = file.kind === "fido2" ? await listFido2Devices() : []
      print(
        fields([
          ["Network", network],
          [
            "Passkey",
            file.kind === "fido2"
              ? `security key (${devices[0]?.label ?? "not plugged in"})`
              : "key file",
          ],
          [
            "Sealed",
            file.kind === "software"
              ? file.software?.sealed
                ? "yes, with ZKMONEY_PASSPHRASE"
                : "no"
              : undefined,
          ],
          ["Tag", file.identity?.tag ? `@${file.identity.tag}` : "none yet"],
          [
            "L2 address",
            file.identity?.l2Address
              ? shorten(file.identity.l2Address, opts.full)
              : "derived on first use",
          ],
          [
            "L1 account",
            file.identity?.l1Account ? shorten(file.identity.l1Account, opts.full) : undefined,
          ],
          ["Created", new Date(file.createdAt).toLocaleString()],
          ["File", accountPath(home, dir)],
        ]),
      )
    })

  cmd
    .command("sync")
    .description("derive the account's addresses and look up its tag on the registry")
    .action(async (_opts: unknown, cmd: Command) => {
      const rt = await boot(cmd.optsWithGlobals())
      try {
        const identity = await readIdentity(rt)
        rememberIdentity(rt.config.home, rt.config.dir, identity)
        print(
          fields([
            ["L2 address", identity.l2Address],
            ["L1 account", identity.l1Account],
            ["Tag", identity.tag ? `@${identity.tag}` : "not registered"],
          ]),
        )
      } finally {
        await rt.close()
      }
    })

  return cmd
}

export { loadConfig }
