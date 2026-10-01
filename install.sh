#!/bin/sh
# Installs the zkmoney CLI on macOS or Linux, x64 or arm64. Inside an unpacked release archive it
# installs that archive; anywhere else it fetches this machine's archive from the newest release of
# aztec-labs-eng/zkmoney-cli with the GitHub CLI. Every release carries this script:
#
#   gh release download -R aztec-labs-eng/zkmoney-cli -p install.sh -O - | sh
#   ... | sh -s -- 0.1.0        that release rather than the newest
#
# ZKMONEY_INSTALL_DIR (default ~/.local/share/zkmoney-cli) holds the install and ZKMONEY_BIN_DIR
# (default ~/.local/bin) gets the zkmoney link.
set -eu

main() {
  repo="${ZKMONEY_REPO:-aztec-labs-eng/zkmoney-cli}"
  dir="${ZKMONEY_INSTALL_DIR:-$HOME/.local/share/zkmoney-cli}"
  dir="${dir%/}"
  bindir="${ZKMONEY_BIN_DIR:-$HOME/.local/bin}"
  version="${1:-}"
  version="${version#v}"
  case "$version" in
    "" | [0-9]*) ;;
    *) die "usage: install.sh [version], e.g. install.sh 0.1.0" ;;
  esac

  if [ -e "$dir" ] && ! is_bundle "$dir" && [ -n "$(ls -A "$dir" 2>/dev/null)" ]; then
    die "$dir holds something other than zkmoney; point ZKMONEY_INSTALL_DIR elsewhere"
  fi

  if [ -z "$version" ] && [ "$(basename "$0")" = install.sh ] && is_bundle "$(dirname "$0")/zkmoney"; then
    place "$(dirname "$0")/zkmoney"
  else
    download
  fi
}

die() {
  echo "zkmoney install: $*" >&2
  exit 1
}

is_bundle() {
  [ -f "$1/lib/main.mjs" ] && grep -q '"name": "@obsidion/zkmoney-cli"' "$1/package.json" 2>/dev/null
}

# The archive follows the Node that will run the CLI, so a Rosetta shell on Apple silicon still
# gets the prover its Node can load.
platform() {
  if command -v node >/dev/null 2>&1; then
    node -p 'process.platform + "-" + process.arch'
  else
    case "$(uname -s)-$(uname -m)" in
      Darwin-arm64) echo darwin-arm64 ;;
      Darwin-x86_64) echo darwin-x64 ;;
      Linux-x86_64) echo linux-x64 ;;
      Linux-aarch64 | Linux-arm64) echo linux-arm64 ;;
      *) echo "$(uname -s)-$(uname -m)" ;;
    esac
  fi
}

sha256_check() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum -c - >/dev/null; else shasum -a 256 -c - >/dev/null; fi
}

download() {
  command -v gh >/dev/null 2>&1 || die "needs the GitHub CLI: https://cli.github.com (or: brew install gh)"
  gh auth status --hostname github.com >/dev/null 2>&1 || die "sign in to GitHub first: gh auth login"
  plat=$(platform)
  case "$plat" in
    darwin-arm64 | darwin-x64 | linux-x64 | linux-arm64) ;;
    *) die "zkmoney runs on macOS and Linux, x64 or arm64; this is $plat" ;;
  esac
  if [ -n "$version" ]; then
    tag="zkmoney-cli-v$version"
  else
    tag=$(gh api "repos/$repo/releases?per_page=100" \
      --jq '[.[] | select(.draft | not) | select(.tag_name | startswith("zkmoney-cli-v"))][0].tag_name // empty') ||
      die "cannot read the releases of $repo with this GitHub login"
    [ -n "$tag" ] || die "$repo has no zkmoney release yet"
  fi
  name="zkmoney-cli-${tag#zkmoney-cli-v}-$plat"
  tmp=$(mktemp -d 2>/dev/null || mktemp -d -t zkmoney)
  trap 'rm -rf "$tmp"' EXIT
  trap 'exit 130' INT TERM
  echo "Downloading $name"
  gh release download "$tag" -R "$repo" -D "$tmp" -p "$name.tar.gz" -p SHA256SUMS ||
    die "could not download $name.tar.gz from the $tag release"
  (cd "$tmp" && grep " $name.tar.gz\$" SHA256SUMS | sha256_check) ||
    die "$name.tar.gz does not match the release's SHA256SUMS"
  tar -xzf "$tmp/$name.tar.gz" -C "$tmp"
  place "$tmp/$name/zkmoney"
}

place() {
  mkdir -p "$(dirname "$dir")" "$bindir"
  rm -rf "$dir.new"
  cp -R "$1" "$dir.new"
  # A browser download quarantines every file on macOS, which stops the prover binary.
  if [ "$(uname -s)" = Darwin ]; then xattr -dr com.apple.quarantine "$dir.new" 2>/dev/null || true; fi
  rm -rf "$dir"
  mv "$dir.new" "$dir"
  ln -sf "$dir/bin/zkmoney" "$bindir/zkmoney"
  if installed=$("$dir/bin/zkmoney" --version); then
    echo "Installed zkmoney $installed in $dir"
  else
    echo "Installed zkmoney in $dir, but it cannot run yet (see above)" >&2
  fi
  case ":$PATH:" in
    *":$bindir:"*) echo "Run: zkmoney --help" ;;
    *) echo "Add $bindir to PATH (export PATH=\"$bindir:\$PATH\"), then run: zkmoney --help" ;;
  esac
}

main "$@"
