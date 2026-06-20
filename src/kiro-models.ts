import { ACPClient, type Model } from "./acp-client"
import { reasoningEffortsFor, type KiroEffortLevel } from "./kiro-effort"

export interface ListModelsOptions {
  cwd?: string
}

/** A `Model` plus its effort levels (`reasoningEfforts`, empty when none). */
export interface ModelWithEfforts extends Model {
  reasoningEfforts: KiroEffortLevel[]
}

/** List available models. Temporarily starts kiro-cli, reads models, then shuts down. */
export async function listModels(options?: ListModelsOptions): Promise<ModelWithEfforts[]> {
  const client = new ACPClient({
    cwd: options?.cwd ?? process.cwd(),
  })

  try {
    await client.start()
    const session = await client.createSession()
    return session.models.availableModels.map((model) => ({
      ...model,
      reasoningEfforts: reasoningEffortsFor(model.modelId),
    }))
  } finally {
    await client.stop()
  }
}
