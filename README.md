# zkmoney CLI

> [!WARNING]
> Experimental. The zkmoney CLI is early software that moves real funds on mainnet. Use it at your own risk, with amounts you can afford to lose.

zk.money from the terminal: register a tag, receive deposits from Ethereum, pay tags, withdraw, make and claim paylinks, and watch the balance. It runs against Ethereum and Aztec mainnet by default and prints plain text, for people at a shell and for agents that run one.

This repository holds the releases. 

## Install

On macOS or Linux, x64 or arm64, with Node.js 22 or later and the GitHub CLI signed in to an account that can read this repository:

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

The full command reference, written for agents as much as for people, is [SKILL.md](SKILL.md); the install puts a copy beside the CLI (`~/.local/share/zkmoney-cli/SKILL.md`). Each release refreshes it here.
