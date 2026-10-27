#!/usr/bin/env node
// Runs the source-generation entry through tsx from wherever the shell is, as bin/zkmoney.mjs does.
import { tsImport } from "tsx/esm/api"

await tsImport("../src/generation.ts", import.meta.url)
