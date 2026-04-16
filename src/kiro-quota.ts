import type { ACPClient } from "./acp-client"

export interface QuotaInfo {
  /** Credits consumed in the current session. */
  sessionCredits: number
  /** Context window usage percentage (0-100). */
  contextUsagePercentage?: number
  /** Raw metering data from the last turn. */
  metering?: Array<{ unit: string; unitPlural: string; value: number }>
}

export interface GetQuotaOptions {
  /** Existing ACP client to use. If not provided, a temporary one is created. */
  client?: ACPClient
  /** Working directory for kiro-cli. Default: process.cwd() */
  cwd?: string
}

/**
 * Get quota/usage information.
 *
 * Note: ACP doesn't expose full subscription details (plan type, monthly limits).
 * This returns per-session credit usage from _kiro.dev/metadata.
 * Full subscription details (plan type, monthly limits) are not available via ACP.
 */
export async function getQuota(options?: GetQuotaOptions): Promise<QuotaInfo> {
  const client = options?.client
  if (!client) {
    return {
      sessionCredits: 0,
      contextUsagePercentage: undefined,
      metering: undefined,
    }
  }

  // Aggregate metadata from all tracked sessions
  // The client stores metadata per-session from _kiro.dev/metadata notifications
  const allMetadata = client.getAllMetadata()

  let totalCredits = 0
  let lastContext: number | undefined
  let lastMetering: QuotaInfo["metering"]

  for (const meta of allMetadata) {
    const credits = meta.meteringUsage?.find((m) => m.unit === "credit")?.value ?? 0
    totalCredits += credits
    lastContext = meta.contextUsagePercentage
    lastMetering = meta.meteringUsage
  }

  return {
    sessionCredits: totalCredits,
    contextUsagePercentage: lastContext,
    metering: lastMetering,
  }
}
