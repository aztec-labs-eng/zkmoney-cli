/**
 * Drives an upgrade run the way the web wallet's queue does: a prepare pass that asks for every
 * approval and proves every refund without sending, then a send pass that publishes the record
 * update and the refunds on the saved approvals, then observation until every refund arrived.
 * Ctrl-C stops between steps; the saved run resumes on the next `zkmoney upgrade`.
 */
import {
  runMetadataMigration,
  type MetadataMigrationController,
  type MetadataMigrationRecord,
  type MetadataMigrationSummary,
} from "../../frontCore.ts"
import { amount as formatAmount } from "../../output.ts"
import { DEFAULT_DECIMALS } from "@obsidion/core/constants"

export function phaseLine(record: MetadataMigrationRecord): string {
  switch (record.phase) {
    case "preparing":
      return "preparing: approving and proving"
    case "broadcasting":
      return "publishing the account's record on the new network"
    case "awaitingMessages":
      return "waiting for the record update to settle"
    case "subscribing":
      return "activating the account's sponsorship"
    case "recovering":
      return "sending the refunds"
    case "arriving":
      return "refunds sent; waiting for them to arrive"
    case "waiting":
      return record.waitReason ?? "waiting for the account's registration"
    case "done":
      return "done"
    case "needsApproval":
      return "stopped: an approval is needed; run `zkmoney upgrade` again"
    case "needsAttention":
      return `stopped: ${record.error ?? "the run needs attention"}`
  }
}

export const summaryLine = (summary: MetadataMigrationSummary): string =>
  `${summary.approvals} approval${summary.approvals === 1 ? "" : "s"}, fees ${formatAmount(
    BigInt(summary.fees),
    DEFAULT_DECIMALS,
    "DAI",
  )}`

/** A signal that fires on Ctrl-C, once. */
export function interruptSignal(): { signal: AbortSignal; release(): void } {
  const controller = new AbortController()
  const stop = () => controller.abort()
  process.once("SIGINT", stop)
  process.once("SIGTERM", stop)
  return {
    signal: controller.signal,
    release() {
      process.off("SIGINT", stop)
      process.off("SIGTERM", stop)
    },
  }
}

const stopped = (record: MetadataMigrationRecord | null) =>
  !record || record.phase === "needsAttention" || record.phase === "needsApproval"

/**
 * One user's start: approvals first, proofs second, then every send, then the wait for arrival.
 * Returns the record where it stopped; `done` when every refund arrived and the balance holds it.
 */
export async function runUpgrade(
  controller: MetadataMigrationController,
  opts: {
    summary: MetadataMigrationSummary
    onLine(line: string): void
    pollMs?: number
  },
): Promise<MetadataMigrationRecord | null> {
  const { signal, release } = interruptSignal()
  let last: string | undefined
  const unsubscribe = controller.subscribe(() => {
    const record = controller.getSnapshot()
    if (!record) return
    const line = phaseLine(record)
    if (line !== last) {
      last = line
      opts.onLine(line)
    }
  })
  try {
    let record: MetadataMigrationRecord | null = null
    for (const approvalsOnly of [true, false]) {
      record = await runMetadataMigration(controller, {
        signal,
        prepareOnly: true,
        approvalsOnly,
        summary: opts.summary,
        beforeApproval: async (approved, total) =>
          opts.onLine(`approval ${approved + 1} of ${total}`),
      })
      if (stopped(record) || signal.aborted) return record
    }
    opts.onLine("approved and proven; sending")
    record = await runMetadataMigration(controller, {
      signal,
      retry: true,
      prompts: false,
      untilArriving: true,
      pollMs: opts.pollMs,
    })
    if (stopped(record) || signal.aborted) return record
    if (record?.phase === "done") return record
    return await runMetadataMigration(controller, {
      signal,
      observeOnly: true,
      pollMs: opts.pollMs,
    })
  } finally {
    unsubscribe()
    release()
  }
}
