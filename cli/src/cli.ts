import { createRequire } from "node:module"
import { Command } from "commander"
import { accountCommand } from "./commands/account.ts"
import { balanceCommand, txsCommand, watchCommand } from "./commands/activity.ts"
import { bridgeCommand, bridgesCommand } from "./commands/bridge.ts"
import { configCommand } from "./commands/config.ts"
import { depositsCommand } from "./commands/deposits.ts"
import { registerCommand } from "./commands/register.ts"
import { savingsCommand } from "./commands/savings.ts"
import { contactsCommand } from "./commands/contacts.ts"
import { paylinkCommand } from "./commands/paylink.ts"
import { paymentsCommand } from "./commands/payments.ts"
import { sendCommand } from "./commands/send.ts"
import { withdrawCommand, withdrawalsCommand } from "./commands/withdraw.ts"
import { setLoggingEnabled } from "./frontCore.ts"
import { CliError, note, rpcRefusal } from "./output.ts"

// front-core's machines log to stdout; only ZKMONEY_DEBUG lets that through the plain output.
setLoggingEnabled(!!process.env.ZKMONEY_DEBUG)

// A closed pipe (`zkmoney txs | head`) is not an error.
process.stdout.on("error", (err: NodeJS.ErrnoException) => {
  if (err.code === "EPIPE") process.exit(0)
  throw err
})

const program = new Command("zkmoney")
  .description("zk.money from the terminal: register a tag, receive, pay, withdraw, bridge")
  .version(createRequire(import.meta.url)("../package.json").version)
  .option("--home <dir>", "where the account, settings and store live (default ~/.zkmoney)")
  .option("--profile <name>", "mainnet, staging (also: testnet), dev or sandbox (default mainnet)")
  .option("--node-url <url>", "Aztec node, overriding the profile")
  .option("--l1-rpc <url>", "Ethereum RPC, overriding the profile")
  .addCommand(accountCommand())
  .addCommand(configCommand())
  .addCommand(registerCommand())
  .addCommand(depositsCommand())
  .addCommand(balanceCommand())
  .addCommand(txsCommand())
  .addCommand(watchCommand())
  .addCommand(sendCommand())
  .addCommand(paymentsCommand())
  .addCommand(withdrawCommand())
  .addCommand(withdrawalsCommand())
  .addCommand(bridgeCommand())
  .addCommand(bridgesCommand())
  .addCommand(savingsCommand())
  .addCommand(paylinkCommand())
  .addCommand(contactsCommand())

program.parseAsync(process.argv).catch((err: unknown) => {
  if (err instanceof CliError) {
    note(`error: ${err.message}`)
    if (err.hint) note(`  ${err.hint}`)
  } else if (rpcRefusal(err)) {
    note(`error: ${rpcRefusal(err)}`)
    note(
      "  set an Ethereum RPC that serves historical logs; `zkmoney config set l1.rpc <url>` saves one for this network",
    )
  } else {
    const message = err instanceof Error ? err.message : String(err)
    note(`error: ${message}`)
    if (/Error 40[13] from server/.test(message))
      note(
        "  the server wants a key; for the Aztec node, `zkmoney config set node.apiKey <key>` saves one for this network",
      )
    if (process.env.ZKMONEY_DEBUG && err instanceof Error) note(err.stack ?? "")
  }
  process.exitCode = 1
})
