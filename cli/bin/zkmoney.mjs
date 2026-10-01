#!/usr/bin/env node
// Runs the TypeScript entry through tsx from wherever the shell is, since `--import tsx` only
// resolves from the current directory.
import { tsImport } from "tsx/esm/api"

// The Aztec libraries log at info to the terminal and the SDK prints progress with console.log;
// the CLI's own output goes through process.stdout, so both are muted unless ZKMONEY_DEBUG is set.
if (!process.env.ZKMONEY_DEBUG) {
  process.env.LOG_LEVEL ??= "error"
  console.log = console.info = console.debug = () => {}
  process.removeAllListeners("warning")
}

await tsImport("../src/cli.ts", import.meta.url)
