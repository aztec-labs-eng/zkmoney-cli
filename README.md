# zkmoney CLI

zk.money from the terminal: register a tag, receive deposits from Ethereum, pay tags, withdraw, make and claim paylinks, and watch the balance. It runs against Ethereum and Aztec mainnet by default and prints plain text, for people at a shell and for agents that run one.

This repository holds the releases. The source is the `@obsidion/zkmoney-cli` package in the zk.money wallet monorepo, which builds and publishes them.

## Install

On macOS or Linux, x64 or arm64, with Node.js 20.10 or later and the GitHub CLI signed in to an account that can read this repository:

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

The full command reference, written for agents as much as for people, is the `SKILL.md` installed beside the CLI (`~/.local/share/zkmoney-cli/SKILL.md`).
