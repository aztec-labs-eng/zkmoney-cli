/**
 * The source-generation entry: a newer CLI runs this build as a child process to read the Aztec v5
 * network, speaking JSON lines over stdio. Stdout is that channel, so every library log goes to
 * stderr, and nothing else writes to stdout.
 */
process.env.LOG_LEVEL ??= "error"
const toStderr = (...args: unknown[]) => {
  if (process.env.ZKMONEY_DEBUG) process.stderr.write(args.map(String).join(" ") + "\n")
}
console.log = console.info = console.debug = toStderr
process.removeAllListeners("warning")

const { serveGeneration } = await import("./generation/server.ts")
await serveGeneration()
