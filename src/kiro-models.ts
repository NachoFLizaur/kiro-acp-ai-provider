import { ACPClient, type Model } from "./acp-client"

export interface ListModelsOptions {
  cwd?: string
}

/** List available models. Temporarily starts kiro-cli, reads models, then shuts down. */
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
