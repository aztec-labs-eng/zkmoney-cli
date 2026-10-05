import { defineConfig } from "vitest/config"

/** Live-network suites, run by `pnpm test:e2e` and never by `pnpm test`. */
export default defineConfig({
  test: { include: ["test/e2e/**/*.e2e.ts"], environment: "node", fileParallelism: false },
})
