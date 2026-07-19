import { ACPClient, type Model } from "./acp-client"
import type { KiroEffort } from "./kiro-effort"

export interface ListModelsOptions {
  cwd?: string
}

/** A normalized runtime `Model` plus its discovered effort options. */
export interface ModelWithEfforts extends Model {
  runtimeEfforts: KiroEffort[]
  baselineEffort?: KiroEffort
}

/** List runtime models and their opaque effort options, then shut down. */
export async function listModels(options?: ListModelsOptions): Promise<ModelWithEfforts[]> {
  const client = new ACPClient({
    cwd: options?.cwd ?? process.cwd(),
  })
  let sessionId: string | undefined
  let originalModelId: string | undefined

  try {
    await client.start()
    const session = await client.createSession()
    sessionId = session.sessionId
    originalModelId = session.models.currentModelId

    const models: ModelWithEfforts[] = []
    for (const model of session.models.availableModels) {
      const preservedModel = { ...model } as Model & Record<string, unknown>
      delete preservedModel.runtimeEfforts
      delete preservedModel.baselineEffort
      let runtimeEfforts: KiroEffort[] = []
      let baselineEffort: KiroEffort | undefined

      try {
        const switched = await client.executeCommand(
          session.sessionId,
          "model",
          { value: model.modelId },
        )
        if (switched.success) {
          const discovered = await client.requestEffortOptions(session.sessionId)
          if (discovered) {
            runtimeEfforts = [...discovered.runtimeEfforts]
            if (
              discovered.baselineEffort !== undefined &&
              runtimeEfforts.includes(discovered.baselineEffort)
            ) {
              baselineEffort = discovered.baselineEffort
            }
          }
        }
      } catch {
        // This model has no usable runtime effort options.
      }

      models.push({
        ...preservedModel,
        runtimeEfforts,
        ...(baselineEffort === undefined ? {} : { baselineEffort }),
      })
    }

    return models
  } finally {
    try {
      if (sessionId && originalModelId) {
        try {
          await client.setModel(sessionId, originalModelId)
        } catch {
          // Restoration is best-effort; shutdown must still run.
        }
      }
    } finally {
      await client.stop()
    }
  }
}
