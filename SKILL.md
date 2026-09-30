---
name: zkmoney-cli
description: Operate a zk.money wallet from the terminal or from an agent - register a tag, receive deposits from Ethereum, check the balance and history, pay tags, withdraw to Ethereum, make and claim paylinks. Use when a task says "zk.money", "zkmoney", "pay <tag>", "deposit address", or needs private payments on Aztec mainnet.
---

# zkmoney CLI

`zkmoney` is a node CLI over the zk.money wallet SDK. It talks to Ethereum mainnet and Aztec mainnet by default, keeps its account and records under `~/.zkmoney/<network>/`, and prints plain text meant to be read; there is no JSON mode. Amounts are decimal strings in the asset's units (`"12.50"`), never base units.

Install it on macOS or Linux (needs Node.js 20.10 or later and a signed-in `gh`) with `gh release download -R aztec-labs-eng/zkmoney-cli -p install.sh -O - | sh`, which puts `zkmoney` in `~/.local/bin`. Inside the zk.money wallet monorepo it also runs from source: `packages/cli/zkmoney/bin/zkmoney.mjs <command>` (or `pnpm --filter @obsidion/zkmoney-cli start -- <command>`). Add `ZKMONEY_DEBUG=1` to see the SDK's own logs.

The Aztec node sits behind a gateway key: set `ZKMONEY_NODE_API_KEY` (or `zkmoney config set node.apiKey …`) before the first command that touches the chain.

## Before anything: an account

```sh
zkmoney account init            # security key if one is plugged in, else a key file
zkmoney account init --key file # force a key file (what an unattended agent uses)
zkmoney account show
```

A key-file account is sealed when `ZKMONEY_PASSPHRASE` is set at init; the same variable opens it later. A security-key account asks for a touch on every signature and is the same passkey the web wallet would use, so the browser can open it too.

The account is a new zk.money account. It cannot drive an account whose passkey lives in a browser or phone, because that key never leaves its authenticator.

An account without a registered tag can receive (sends to its L2 address, vouchered paylinks) but cannot send, withdraw, create paylinks or deposit addresses: every one of those is paid for by the tag's sponsorship. Register first when the agent needs to spend.

## Getting funds in

**Register a tag** (a name like `alice`, paid for by an L1 deposit of 15 DAI, or 5 DAI when the account holds an earned waiver):

```sh
zkmoney register alice                       # prints the deposit address, the amount, the hold deadline
zkmoney register alice --fund --wait         # fund from ZKMONEY_L1_PRIVATE_KEY and wait for the name
zkmoney register status
```

Send the printed amount in DAI, USDC or USDT (TST on testnet) to the printed address from any Ethereum wallet or exchange, in one transfer, before the hold deadline. A relayer sweeps it, the name goes live, and the remainder above the fee becomes the opening balance. `register status` tells you which step it is at.

**Receive without a tag or later on:**

```sh
zkmoney deposits create --asset USDC --amount 50   # a fresh address; the asset and amount are the request you hand out
zkmoney deposits get <address>
zkmoney deposits list
```

Each address takes DAI, USDC or USDT on mainnet (TST on testnet), once. Anything else sent there needs manual recovery. The depositor pays the sweep fee and the portal cut printed by `create`; the rest is credited in DAI on Aztec. Credit lands after the relayer sweeps and the next `balance` or `watch` tick claims it.

## Reading state

```sh
zkmoney balance                 # one sync, then the private balance
zkmoney txs [-n 20] [--sent|--received] [--full]
zkmoney watch [--interval 15] [--once]   # a line per balance change, receive, send
```

`watch` polls; a payment shows within one interval plus block time. Keep only one long-running `watch` per account.

## Paying

```sh
zkmoney send 12.50 DAI --to bob --idempotency-key req-42 [--memo "invoice 42"]
zkmoney payments get req-42
zkmoney payments list
```

`--to` takes a saved contact name, a bare tag, or a full L2 address. The only L2 asset is DAI; other assets are refused. Always pass `--idempotency-key`: a retry with the same key returns the earlier payment instead of paying twice, and the key is the payment id `payments get` takes. Statuses: `pending`, `mined`, `failed`.

## Withdrawing to Ethereum

```sh
zkmoney withdraw 100 --to 0xabc… [--asset DAI|USDC|USDT|ETH] --idempotency-key wd-7 [--wait]
zkmoney withdrawals get wd-7
zkmoney withdrawals list
```

A DAI withdrawal pays the address directly; USDC, USDT and ETH go through a swap on L1 and pay what the swap returns (mainnet only). The payout waits for the rollup to prove the burn's block, which takes minutes on mainnet and can take much longer on testnet. The recipient address is screened on mainnet; a refused address fails before anything is burned. `withdrawals get` shows the phase from burn to payout and the L1 hash once paid.

## Paylinks

```sh
zkmoney paylink create 5 [--memo "coffee"] --idempotency-key pl-1   # prints the link to share
zkmoney paylink create 5 --no-voucher                             # the claimer must have a tag
zkmoney paylink status <id or link>
zkmoney paylink claim <link>          # claims into this account
zkmoney paylink cancel <id>           # refunds an unclaimed link, once its window allows
```

A link carries a voucher by default when the creator's allowance covers it: one sponsored transaction, so an account without a tag can claim it. A link opens for claims about a minute after it is created, by chain time; `claim` says how long to wait.

## Contacts

```sh
zkmoney contacts add bob --tag bob          # resolves the tag now and pins its address
zkmoney contacts add cold --eth 0xabc…      # an Ethereum address for withdrawals
zkmoney contacts list
zkmoney contacts remove bob
```

## Settings

```sh
zkmoney config show                       # value and source of every setting
zkmoney config set node.url https://…     # pin one; flag > env > file > profile
zkmoney config unset node.url
```

Keys: `profile`, `profileUrl`, `node.url`, `node.apiKey`, `l1.rpc`, `accountService.url`, `addresses.{registry,portal,token,claimFpc}`, `defaults.{asset,withdrawAsset}`. Environment equivalents are `ZKMONEY_<KEY>` (`ZKMONEY_NODE_URL`, `ZKMONEY_L1_RPC`, …). `--profile testnet|sandbox` switches network for one command, `ZKMONEY_PROFILE` for a shell, `config set profile` until unset; mainnet is the default. Each network keeps its own account and store under `~/.zkmoney/<network>/`, so a network's first use starts with `account init`. `--home <dir>` moves everything.

## Reading the output

- Every command exits non-zero on failure and prints `error: <what happened>` and, when there is one, a second line with what to do.
- Addresses and hashes are shortened (`0xdf41…9449`); `--full` prints them whole.
- Times are local; amounts carry their asset (`12.50 DAI`).
- A line starting with `note:` is advisory and goes to stderr.

## Limits to keep in mind

- Per-transaction cap and a shared daily deposit bucket apply on mainnet; an over-cap deposit sits at its address until recovered, and an over-cap send fails at send.
- A registration deposit must arrive before the 7-day hold ends.
- One process should own the account's PXE at a time; run `watch` in one terminal and issue `send` from the same store, not two concurrent long-running processes.
