import { ACPClient, type Model } from "./acp-client"

export interface ListModelsOptions {
  /** Working directory for kiro-cli. Default: process.cwd() */
  cwd?: string
}

/**
 * List available Kiro models.
 * Temporarily starts kiro-cli, creates a session to read models, then shuts down.
 */
export async function listModels(options?: ListModelsOptions): Promise<Model[]> {
  const client = new ACPClient({
    cwd: options?.cwd ?? process.cwd(),
  })

  try {
    await client.start()
    const session = await client.createSession()
    return session.models.availableModels
  } finally {
    await client.stop()
  }
}
