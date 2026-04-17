import type { ACPClient } from "./acp-client"

export interface QuotaInfo {
  sessionCredits: number
  contextUsagePercentage?: number
  metering?: Array<{ unit: string; unitPlural: string; value: number }>
}

export interface GetQuotaOptions {
  client?: ACPClient
  cwd?: string
}

/**
 * Get per-session credit usage from _kiro.dev/metadata.
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
