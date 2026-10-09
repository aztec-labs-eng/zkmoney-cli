#!/bin/sh
# Builds the zk.money packages the CLI compiles against: zkmoney-public at the pinned commit, cloned
# into .public/, with cli/ joined to its pnpm workspace. Needs the tools zkmoney-public's README lists
# for its contract build: pnpm 9, the Aztec 5.2.0 toolchain, Foundry and Yarn through corepack.
#
# ZKMONEY_WALLET_DIR=<checkout> builds against a local wallet checkout instead, for changes not yet in
# zkmoney-public. That checkout compiles its own contracts (`pnpm build-contracts`), and its
# pnpm-workspace.yaml and pnpm-lock.yaml gain cli/, which must not be committed there.
set -eu

PUBLIC_REPO=https://github.com/aztec-labs-eng/zkmoney-public.git
PUBLIC_COMMIT=835f726063f5f3a92405e26180f510a09ea32c46

root=$(cd "$(dirname "$0")/.." && pwd)

if [ -n "${ZKMONEY_WALLET_DIR:-}" ]; then
  dir=$(cd "$ZKMONEY_WALLET_DIR" && pwd)
else
  dir="$root/.public/zkmoney-public"
  [ -d "$dir/.git" ] || git clone -q "$PUBLIC_REPO" "$dir"
  git -C "$dir" fetch -q origin "$PUBLIC_COMMIT"
  git -C "$dir" checkout -q --force "$PUBLIC_COMMIT"
  git -C "$dir" submodule update -q --init --recursive
fi
cli=$(node -e 'console.log(require("node:path").relative(process.argv[1], process.argv[2]))' "$dir" "$root/cli")
grep -qx "  - $cli" "$dir/pnpm-workspace.yaml" || printf '  - %s\n' "$cli" >> "$dir/pnpm-workspace.yaml"

cd "$dir"
pnpm install
[ -n "${ZKMONEY_WALLET_DIR:-}" ] || pnpm build-contracts
pnpm --filter '@obsidion/zkmoney-cli^...' --filter '!@oxide/*' -r --if-present run build
