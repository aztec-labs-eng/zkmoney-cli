import { Command } from "commander"
import { getAddress, isAddress } from "viem"
import {
  ContactStorage,
  normalizeTag,
  resolveTagViaRegistry,
  validateAddress,
  type Contact,
} from "../frontCore.ts"
import { loadConfig } from "../config.ts"
import { fail, fields, print, shorten, table } from "../output.ts"
import { boot, storagePath } from "../runtime/boot.ts"
import { registryOpts } from "../runtime/sync.ts"
import { FileStorageAdapter } from "../storage.ts"

type Globals = { home?: string; profile?: string; nodeUrl?: string; l1Rpc?: string }

/** The contact book alone, without a PXE. */
async function contactsOf(cmd: Command): Promise<ContactStorage> {
  const config = await loadConfig(cmd.optsWithGlobals<Globals>())
  return ContactStorage.get(new FileStorageAdapter(storagePath(config)))
}

const live = (c: Contact) => !c.l1Wallet?.deletedAt
const kindOf = (c: Contact) => c.addressKind ?? "aztec-l2"

export function findContact(contacts: Contact[], name: string): Contact | undefined {
  const needle = name.trim().toLowerCase()
  return contacts.find((c) => live(c) && c.name.toLowerCase() === needle)
}

function describe(c: Contact, full?: boolean): string[] {
  const kind = kindOf(c)
  return [
    c.name,
    kind === "ethereum-l1" ? "ethereum" : kind === "aztec-l2" ? "zk.money" : "pending",
    c.tag ? `@${c.tag}` : "",
    shorten(c.address, full),
  ]
}

export function contactsCommand(): Command {
  const cmd = new Command("contacts").description(
    "saved recipients: tags, L2 addresses, Ethereum addresses",
  )

  cmd
    .command("add <name>")
    .description("save a recipient under a name")
    .option("--tag <tag>", "a registered tag, resolved on the registry now")
    .option("--eth <address>", "an Ethereum address, for withdrawals")
    .option("--l2 <address>", "a 0x L2 address")
    .action(
      async (name: string, opts: { tag?: string; eth?: string; l2?: string }, cmd: Command) => {
        const label = name.trim()
        if (!label) fail("the name is empty")
        const given = [opts.tag, opts.eth, opts.l2].filter((v) => v !== undefined).length
        if (given !== 1) fail("give exactly one of --tag, --eth or --l2")
        if (opts.eth !== undefined) {
          if (!isAddress(opts.eth)) fail(`"${opts.eth}" is not an Ethereum address`)
          const contacts = await contactsOf(cmd)
          const saved = await contacts.upsertL1WalletContact({
            name: label,
            address: getAddress(opts.eth),
            provider: "manual",
            walletName: label,
            provenance: "saved-recipient",
            userLabeled: true,
          })
          return print(
            fields([
              ["Saved", saved.name],
              ["Ethereum", saved.address],
            ]),
          )
        }
        if (opts.l2 !== undefined) {
          if (!/^0x[0-9a-fA-F]{64}$/.test(opts.l2) || !validateAddress(opts.l2))
            fail(`"${opts.l2}" is not an L2 address`)
          const contacts = await contactsOf(cmd)
          const saved = await contacts.addOrMergeContact({
            name: label,
            address: opts.l2,
            addressKind: "aztec-l2",
          })
          return print(
            fields([
              ["Saved", saved.name],
              ["L2 address", saved.address],
              [
                "Note",
                saved.name !== label ? "that address was already saved under this name" : undefined,
              ],
            ]),
          )
        }
        const tag = normalizeTag(opts.tag!)
        if (!tag) fail(`"${opts.tag}" is not a tag`, "a tag is letters, digits, _ and -")
        const rt = await boot(cmd.optsWithGlobals<Globals>())
        try {
          const resolved = await resolveTagViaRegistry(tag, registryOpts(rt))
          if (resolved.status === "notFound") fail(`@${tag} is not registered`)
          if (resolved.status === "staleRollup")
            fail(`@${tag} has not upgraded to the current network yet`)
          const saved = await ContactStorage.get(rt.storage).addOrMergeContact({
            name: label,
            address: resolved.l2Address,
            addressKind: "aztec-l2",
            tag,
            verified: true,
          })
          print(
            fields([
              ["Saved", saved.name],
              ["Tag", `@${saved.tag ?? tag}`],
              ["L2 address", saved.address],
              [
                "Note",
                saved.name !== label ? "that tag was already saved under this name" : undefined,
              ],
            ]),
          )
        } finally {
          await rt.close()
        }
      },
    )

  cmd
    .command("list")
    .description("every saved contact")
    .option("--full", "print full addresses")
    .action(async (opts: { full?: boolean }, cmd: Command) => {
      const rows = (await (await contactsOf(cmd)).getEntries()).filter(live)
      if (!rows.length) return print("No contacts yet.")
      print(
        table(
          rows.sort((a, b) => a.name.localeCompare(b.name)).map((c) => describe(c, opts.full)),
          ["name", "network", "tag", "address"],
        ),
      )
    })

  cmd
    .command("remove <name>")
    .description("forget a saved contact")
    .action(async (name: string, _opts: unknown, cmd: Command) => {
      const contacts = await contactsOf(cmd)
      const contact = findContact(await contacts.getEntries(), name)
      if (!contact) fail(`no contact "${name}"`)
      if (kindOf(contact) === "ethereum-l1") {
        await contacts.deleteL1WalletContact({
          address: contact.address,
          provider: contact.l1Wallet?.provider ?? "manual",
        })
      } else {
        await contacts.removeEntry({ address: contact.address, addressKind: kindOf(contact) })
      }
      print(`removed ${contact.name}`)
    })

  return cmd
}
