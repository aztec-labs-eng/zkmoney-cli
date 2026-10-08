// Builds installable zkmoney bundles for macOS and Linux, x64 and arm64: the CLI compiled to one
// file, its production dependencies in a flat node_modules, a launcher and install.sh. Each machine
// gets a tar.gz with only its own native builds; one zip carries all four. SHA256SUMS lists them.
// Node 22 or later runs the result: the PXE uses Set methods Node 20 lacks.
//
//   pnpm --filter @obsidion/zkmoney-cli bundle [out-dir]
import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import {
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { homedir } from "node:os"
import { basename, dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { build } from "esbuild"

const pkgDir = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const repoRoot = resolve(pkgDir, "..")
// Where scripts/setup.sh joined the CLI to a pnpm workspace: zkmoney-public, or ZKMONEY_WALLET_DIR's wallet checkout.
const workspace = process.env.ZKMONEY_WALLET_DIR
  ? resolve(process.env.ZKMONEY_WALLET_DIR)
  : join(repoRoot, ".public/zkmoney-public")
const version = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8")).version
const outRoot = resolve(process.argv[2] ?? join(pkgDir, "release"))
const name = `zkmoney-cli-${version}`
const stage = join(outRoot, "stage")
const app = join(stage, "zkmoney")

const TARGETS = {
  "darwin-arm64": { os: "darwin", cpu: "arm64", bb: "arm64-macos" },
  "darwin-x64": { os: "darwin", cpu: "x64", bb: "amd64-macos" },
  "linux-x64": { os: "linux", cpu: "x64", libc: "glibc", bb: "amd64-linux" },
  "linux-arm64": { os: "linux", cpu: "arm64", libc: "glibc", bb: "arm64-linux" },
}

const run = (cmd, args, cwd = workspace) => execFileSync(cmd, args, { cwd, stdio: "inherit" })

rmSync(stage, { recursive: true, force: true })
mkdirSync(stage, { recursive: true })
for (const file of readdirSync(outRoot)) {
  if (file === "SHA256SUMS" || /^zkmoney-cli-.*\.(tar\.gz|zip)$/.test(file))
    rmSync(join(outRoot, file))
}

// Production dependencies, workspace packages included, in a flat node_modules with no symlinks,
// so the archive unpacks the same everywhere. pnpm 9 reads two needed switches only from the root
// manifest: one lets the deploy skip the root's patch for a package this one does not use, the
// other installs every target's native packages rather than this machine's. Both are set for the
// deploy and the manifest restored byte for byte.
const rootManifest = join(workspace, "package.json")
const original = readFileSync(rootManifest, "utf8")
const relaxed = JSON.parse(original)
relaxed.pnpm = {
  ...relaxed.pnpm,
  allowNonAppliedPatches: true,
  supportedArchitectures: { os: ["darwin", "linux"], cpu: ["arm64", "x64"], libc: ["glibc"] },
}
writeFileSync(rootManifest, JSON.stringify(relaxed, null, 2) + "\n")
try {
  run("pnpm", [
    "--filter",
    "@obsidion/zkmoney-cli",
    "deploy",
    "--prod",
    "--config.node-linker=hoisted",
    app,
  ])
} finally {
  writeFileSync(rootManifest, original)
}

// The CLI and the workspace packages as one file, since their compiled output uses extensionless
// imports that only a bundler resolves. Every other package stays an import of node_modules,
// except one a workspace package keeps its own version of: that one is compiled in from the
// workspace's install, where each importer still finds the version it was built against.
const nodeModules = join(app, "node_modules")
const WORKSPACE_SCOPES = ["@obsidion", "@oxide"]
const compiledIn = new Set()
for (const scope of WORKSPACE_SCOPES) {
  for (const pkg of readdirSync(join(nodeModules, scope))) {
    const own = join(nodeModules, scope, pkg, "node_modules")
    for (const entry of existsSync(own) ? readdirSync(own) : []) {
      if (entry.startsWith("@"))
        for (const sub of readdirSync(join(own, entry))) compiledIn.add(`${entry}/${sub}`)
      else if (!entry.startsWith(".")) compiledIn.add(entry)
    }
  }
}
const packageOf = (path) =>
  path
    .split("/")
    .slice(0, path.startsWith("@") ? 2 : 1)
    .join("/")
await build({
  entryPoints: [join(pkgDir, "src/cli.ts")],
  outfile: join(app, "lib/cli.mjs"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  logLevel: "warning",
  plugins: [
    {
      name: "external-dependencies",
      setup(b) {
        b.onResolve({ filter: /^[^./]/ }, (args) => {
          const pkg = packageOf(args.path)
          return WORKSPACE_SCOPES.includes(pkg.split("/")[0]) || compiledIn.has(pkg)
            ? undefined
            : { path: args.path, external: true }
        })
      },
    },
  ],
})

// The contract artifacts carry the build machine's absolute source paths; keep them home-relative.
const cli = join(app, "lib/cli.mjs")
writeFileSync(cli, readFileSync(cli, "utf8").replaceAll(`${homedir()}/`, "~/"))

// The entry quiets the libraries before anything imports them, then loads the CLI.
writeFileSync(
  join(app, "lib/main.mjs"),
  `if (!process.env.ZKMONEY_DEBUG) {
  process.env.LOG_LEVEL ??= "error"
  console.log = console.info = console.debug = () => {}
}
await import("./cli.mjs")
`,
)

mkdirSync(join(app, "bin"), { recursive: true })
writeFileSync(
  join(app, "bin/zkmoney"),
  `#!/bin/sh
# zkmoney launcher: finds its install, checks Node, runs the CLI.
set -e
self="$0"
while [ -h "$self" ]; do
  link=$(readlink "$self")
  case "$link" in /*) self="$link" ;; *) self="$(dirname "$self")/$link" ;; esac
done
root="$(cd "$(dirname "$self")/.." && pwd)"
node="\${ZKMONEY_NODE:-node}"
if ! command -v "$node" >/dev/null 2>&1; then
  echo "zkmoney needs Node.js 22 or later: https://nodejs.org (or: brew install node)" >&2
  exit 1
fi
if ! "$node" -e 'process.exit(Number(process.versions.node.split(".")[0])>=22?0:1)'; then
  echo "zkmoney needs Node.js 22 or later; found $("$node" --version)" >&2
  exit 1
fi
# Node's own warnings, such as experimental JSON imports in dependencies, mean nothing to a user.
quiet=--no-warnings
[ -z "\${ZKMONEY_DEBUG:-}" ] || quiet=
exec "$node" $quiet "$root/lib/main.mjs" "$@"
`,
)
chmodSync(join(app, "bin/zkmoney"), 0o755)
copyFileSync(join(repoRoot, "install.sh"), join(stage, "install.sh"))
chmodSync(join(stage, "install.sh"), 0o755)

for (const doc of ["README.md", "SKILL.md"]) copyFileSync(join(repoRoot, doc), join(app, doc))
// The deployed copy of the package carries its TypeScript sources and tests; the bundle runs lib/.
for (const entry of [
  "src",
  "test",
  "scripts",
  "release",
  "scratch",
  "bin/zkmoney.mjs",
  "tsconfig.json",
  "vitest.config.ts",
])
  rmSync(join(app, entry), { recursive: true, force: true })

// Only what runs: the workspace packages live in lib/cli.mjs, the SDK lists TypeScript as a
// dependency but never loads it, and rollup, a build tool the SDK's test runner pulls in, carries
// an lzma binding the CLI never loads either.
for (const scope of WORKSPACE_SCOPES)
  rmSync(join(nodeModules, scope), { recursive: true, force: true })
rmSync(join(nodeModules, "typescript"), { recursive: true, force: true })
// pnpm's own install records, which name the build machine's paths.
rmSync(join(nodeModules, ".modules.yaml"), { force: true })
rmSync(join(nodeModules, ".pnpm"), { recursive: true, force: true })
run("find", [
  nodeModules,
  "-type",
  "d",
  "(",
  "-name",
  ".bin",
  "-o",
  "-path",
  "*/@napi-rs/lzma*",
  ")",
  "-prune",
  "-exec",
  "rm",
  "-rf",
  "{}",
  "+",
])
run("find", [nodeModules, "-mindepth", "1", "-maxdepth", "1", "-type", "d", "-empty", "-delete"])
run("find", [
  nodeModules,
  "-type",
  "f",
  "(",
  "-name",
  "*.map",
  "-o",
  "-name",
  "*.d.ts",
  "-o",
  "-name",
  "*.d.mts",
  "-o",
  "-name",
  "*.d.cts",
  ")",
  "-delete",
])
if (readdirSync(join(nodeModules, "@aztec/bb.js/build")).length < Object.keys(TARGETS).length)
  throw new Error("bb.js is missing prover builds for some targets")

// npm's reading of a package's os, cpu or libc list: `!x` rules x out, plain entries allow only themselves.
const admits = (list, value) => {
  const entries = list === undefined ? [] : [].concat(list)
  if (entries.includes(`!${value}`)) return false
  return entries.every((entry) => entry.startsWith("!")) || entries.includes(value)
}

/** Drops, at any depth, the packages whose os, cpu or libc rule out `target`. */
function dropForeign(modules, target) {
  for (const entry of readdirSync(modules)) {
    if (entry.startsWith(".")) continue
    const dirs = entry.startsWith("@")
      ? readdirSync(join(modules, entry)).map((pkg) => join(modules, entry, pkg))
      : [join(modules, entry)]
    for (const dir of dirs) {
      if (!existsSync(join(dir, "package.json"))) continue
      const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"))
      const fits =
        admits(pkg.os, target.os) &&
        admits(pkg.cpu, target.cpu) &&
        (!target.libc || admits(pkg.libc, target.libc))
      if (!fits) rmSync(dir, { recursive: true, force: true })
      else if (existsSync(join(dir, "node_modules"))) dropForeign(join(dir, "node_modules"), target)
    }
  }
}

const outputs = []
for (const [label, target] of Object.entries(TARGETS)) {
  const dirName = `${name}-${label}`
  const dir = join(outRoot, dirName)
  rmSync(dir, { recursive: true, force: true })
  cpSync(stage, dir, { recursive: true })
  const modules = join(dir, "zkmoney/node_modules")
  dropForeign(modules, target)
  for (const build of readdirSync(join(modules, "@aztec/bb.js/build"))) {
    if (build !== target.bb)
      rmSync(join(modules, "@aztec/bb.js/build", build), { recursive: true, force: true })
  }
  run("tar", ["-czf", `${dirName}.tar.gz`, dirName], outRoot)
  rmSync(dir, { recursive: true, force: true })
  outputs.push(join(outRoot, `${dirName}.tar.gz`))
}
// Every target in one zip; Python's zipfile keeps file modes.
const zipDir = `${name}-universal`
cpSync(stage, join(outRoot, zipDir), { recursive: true })
run("python3", ["-m", "zipfile", "-c", `${zipDir}.zip`, zipDir], outRoot)
rmSync(join(outRoot, zipDir), { recursive: true, force: true })
outputs.push(join(outRoot, `${zipDir}.zip`))

const sha256 = (file) => createHash("sha256").update(readFileSync(file)).digest("hex")
writeFileSync(
  join(outRoot, "SHA256SUMS"),
  outputs.map((file) => `${sha256(file)}  ${basename(file)}\n`).join(""),
)
console.log("\n" + [...outputs, join(outRoot, "SHA256SUMS")].join("\n"))
