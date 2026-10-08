# zkmoney CLI

> [!WARNING]
> Experimental. The zkmoney CLI is early software that moves real funds on mainnet. Use it at your own risk, with amounts you can afford to lose.

zk.money from the terminal: register a tag, receive deposits from Ethereum, pay tags, withdraw to Ethereum or bridge to other chains, make and claim paylinks, and watch the balance. It runs against Ethereum and Aztec mainnet by default and prints plain text, for people at a shell and for agents that run one.

This repository holds the CLI's source and its releases. The source builds against [zkmoney-public](https://github.com/aztec-labs-eng/zkmoney-public), the public source of the zk.money wallet, at a pinned commit.

## Install

On macOS or Linux, x64 or arm64, with Node.js 22 or later and the GitHub CLI signed in:

```sh
gh release download -R aztec-labs-eng/zkmoney-cli -p install.sh -O - | sh
```

The installer downloads this machine's archive from the newest release, checks it against the release's `SHA256SUMS`, installs it in `~/.local/share/zkmoney-cli` and links `~/.local/bin/zkmoney` (`ZKMONEY_INSTALL_DIR` and `ZKMONEY_BIN_DIR` move them). `| sh -s -- 0.1.0` picks a release; running it again upgrades. An archive downloaded by hand installs with the `install.sh` inside it.

## Use

```sh
zkmoney --help
zkmoney account init
zkmoney register <tag>
```

The full command reference, written for agents as much as for people, is [SKILL.md](SKILL.md); the install puts a copy beside the CLI (`~/.local/share/zkmoney-cli/SKILL.md`). Before the first command on a network, save that network's Aztec node key, and on mainnet an Ethereum RPC that serves historical logs; SKILL.md's Networks section shows how.

## Build from source

Needs pnpm 9, Node.js 22, and the tools zkmoney-public lists for its contract build: the Aztec 5.2.0 toolchain (`aztec`, `aztec-nargo`), Foundry, and Yarn through corepack.

```sh
git clone https://github.com/aztec-labs-eng/zkmoney-cli && cd zkmoney-cli
scripts/setup.sh            # zkmoney-public at the pinned commit in .public/, contracts compiled, packages built
cd cli
pnpm test && pnpm typecheck
./bin/zkmoney.mjs --help    # runs from source
pnpm bundle                 # release/: a tar.gz per platform, a zip for all of them, SHA256SUMS
```

`scripts/setup.sh` joins `cli/` to zkmoney-public's pnpm workspace, so the CLI compiles against the same packages the web wallet ships. To move to a newer zkmoney-public, change `PUBLIC_COMMIT` there and run it again.

## Releasing

Bump `version` in `cli/package.json`, commit and push, then run `pnpm release` from `cli/`. It bundles that commit and publishes it here as `zkmoney-cli-v<version>`, with `install.sh` and `SHA256SUMS` among the assets. A release that needs wallet code zkmoney-public does not have yet is built over a clean wallet checkout instead: set `ZKMONEY_WALLET_DIR` for both `scripts/setup.sh` and `pnpm release`, and the notes name the wallet and Oxide commits.

## Layout

- `cli/src/commands/` one file per command group.
- `cli/src/runtime/` the wallet boot (`boot.ts`), ClaimFPC sponsorship (`sponsor.ts`), chain sync (`sync.ts`), and the flows.
- `cli/src/keystore/` the passkey backends (`fido2.ts`, `software.ts`) and the account file.
- `cli/src/frontCore.ts` the part of front-core a node process can load; the CLI never loads React.
- `install.sh` the installer, inside every archive and attached to every release.
