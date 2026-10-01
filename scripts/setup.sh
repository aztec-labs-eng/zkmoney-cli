#!/bin/sh
# Builds the zk.money packages the CLI compiles against: zkmoney-public at the pinned commit, cloned
# into .public/, with cli/ joined to its pnpm workspace. Needs the tools zkmoney-public's README lists
# for its contract build: pnpm 9, the Aztec 5.2.0 toolchain, Foundry and Yarn through corepack.
set -eu

PUBLIC_REPO=https://github.com/aztec-labs-eng/zkmoney-public.git
PUBLIC_COMMIT=68425f9cf408ac803eade04d10318fcf345444a0

root=$(cd "$(dirname "$0")/.." && pwd)
dir="$root/.public/zkmoney-public"

[ -d "$dir/.git" ] || git clone -q "$PUBLIC_REPO" "$dir"
git -C "$dir" fetch -q origin "$PUBLIC_COMMIT"
git -C "$dir" checkout -q --force "$PUBLIC_COMMIT"
git -C "$dir" submodule update -q --init --recursive
printf '  - ../../cli\n' >> "$dir/pnpm-workspace.yaml"

cd "$dir"
pnpm install
pnpm build-contracts
pnpm --filter '@obsidion/zkmoney-cli^...' --filter '!@oxide/*' -r --if-present run build
