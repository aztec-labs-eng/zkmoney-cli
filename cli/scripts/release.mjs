// Publishes the bundle as the release zkmoney-cli-v<version> of aztec-labs-eng/zkmoney-cli, with install.sh
// beside the archives so `gh release download -p install.sh` fetches the newest release's installer. It
// bundles this repository's HEAD, committed and pushed, and the release's tag points at it. With
// ZKMONEY_WALLET_DIR, as for scripts/setup.sh, it bundles over that wallet checkout instead of zkmoney-public,
// for a release that needs wallet code zkmoney-public does not have; the notes name its commits.
//
//   [ZKMONEY_WALLET_DIR=<checkout>] pnpm release [out-dir]
import { execFileSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const REPO = "aztec-labs-eng/zkmoney-cli"
const pkgDir = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const repoRoot = resolve(pkgDir, "..")
const version = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8")).version
const outRoot = resolve(process.argv[2] ?? join(pkgDir, "release"))
const tag = `zkmoney-cli-v${version}`
const git = (...args) => execFileSync("git", args, { cwd: repoRoot, encoding: "utf8" }).trim()

if (git("status", "--porcelain", "--untracked-files=no"))
  throw new Error("commit first: the release is built from HEAD")
const head = git("rev-parse", "HEAD")
if (!git("branch", "--remotes", "--contains", head))
  throw new Error(`push ${head} first: the ${tag} tag points at it`)
const walletDir = process.env.ZKMONEY_WALLET_DIR && resolve(process.env.ZKMONEY_WALLET_DIR)
let over
if (walletDir) {
  // scripts/setup.sh joins cli/ to the wallet's workspace, which edits these two files and nothing else.
  const changed = git("-C", walletDir, "status", "--porcelain", "--untracked-files=no")
    .split("\n")
    .filter((line) => line && !/ (pnpm-workspace\.yaml|pnpm-lock\.yaml)$/.test(line))
  if (changed.length) throw new Error(`${walletDir} has changes: ${changed.join(", ")}`)
  const wallet = git("-C", walletDir, "rev-parse", "HEAD")
  if (!git("-C", walletDir, "branch", "--remotes", "--contains", wallet))
    throw new Error(`the wallet checkout's ${wallet} is on no pushed branch`)
  const oxide = git("-C", join(walletDir, "vendor/oxide"), "rev-parse", "HEAD")
  const pinnedOxide = git("-C", walletDir, "rev-parse", "HEAD:vendor/oxide")
  if (oxide !== pinnedOxide)
    throw new Error(`vendor/oxide holds ${oxide}, not the wallet's pinned ${pinnedOxide}`)
  over = `obsidion-wallet ${wallet} (Oxide ${oxide}), wallet code zkmoney-public does not carry yet`
} else {
  const pinned = readFileSync(join(repoRoot, "scripts/setup.sh"), "utf8").match(
    /^PUBLIC_COMMIT=(\w+)/m,
  )?.[1]
  const built = git("-C", join(repoRoot, ".public/zkmoney-public"), "rev-parse", "HEAD")
  if (built !== pinned)
    throw new Error(`.public/ holds zkmoney-public ${built}, not ${pinned}: run scripts/setup.sh`)
  over = `zkmoney-public ${built}`
}

execFileSync("node", [join(pkgDir, "scripts/bundle.mjs"), outRoot], { stdio: "inherit" })
const sums = join(outRoot, "SHA256SUMS")
const archives = readFileSync(sums, "utf8")
  .trim()
  .split("\n")
  .map((line) => join(outRoot, line.split("  ")[1]))
execFileSync(
  "gh",
  [
    "release",
    "create",
    tag,
    ...archives,
    sums,
    join(repoRoot, "install.sh"),
    "--repo",
    REPO,
    "--target",
    head,
    "--title",
    `zkmoney CLI ${version}`,
    "--notes",
    `Install on macOS or Linux, x64 or arm64 (needs Node.js 22 or later and a signed-in gh):\n\n    gh release download -R ${REPO} -p install.sh -O - | sh\n\nBuilt from ${head} over ${over}.`,
  ],
  { stdio: "inherit" },
)
