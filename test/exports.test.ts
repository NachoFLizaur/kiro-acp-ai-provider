import { describe, test, expect } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import * as root from "../src/index"
import * as ipc from "../src/ipc"
import type {
  EffortOptionsResult,
  KiroEffort,
  ListModelsOptions,
  ModelWithEfforts,
} from "../src/index"

// ---------------------------------------------------------------------------
// Export-surface regression.
//
// opencode's SDK auto-discovery (`resolveSDK` in its provider.ts) takes the
// first key of the sorted root namespace matching `create*` as the provider
// factory. A root-level `createIPCServer` sorts before `createKiroAcp`
// ("I" < "K") and would shadow it, breaking languageModel resolution on stock
// opencode. The factory therefore lives on the `kiro-acp-ai-provider/ipc`
// subpath; only types stay at the root.
// ---------------------------------------------------------------------------

describe("root export surface", () => {
  test("sorted root create* keys are exactly [\"createKiroAcp\"]", () => {
    const createKeys = Object.keys(root)
      .filter((key) => key.startsWith("create"))
      .sort()

    expect(createKeys).toEqual(["createKiroAcp"])
    expect(typeof root.createKiroAcp).toBe("function")
  })

  test("createIPCServer is NOT a runtime key of the root namespace", () => {
    expect("createIPCServer" in root).toBe(false)
  })

  test("exports runtime utilities", () => {
    expect(typeof root.interceptSessionAffinity).toBe("function")
    expect(typeof root.hashPromptMessages).toBe("function")
    expect(typeof root.diverged).toBe("function")
    expect(typeof root.listModels).toBe("function")
  })

  test("verifyAuthAsync is an additive root export; auto-discovery still picks createKiroAcp", () => {
    expect(typeof root.verifyAuthAsync).toBe("function")
    expect(typeof root.verifyAuth).toBe("function")

    // "v" sorts after "c": the first sorted create* key must remain the factory.
    const firstCreate = Object.keys(root)
      .sort()
      .find((key) => key.startsWith("create"))
    expect(firstCreate).toBe("createKiroAcp")
  })

  test("exports the required runtime model and one opaque effort contract", () => {
    const runtimeEffort: KiroEffort = "Future/MAX.v2+Beta!"
    const options = { cwd: "/runtime-catalog" } satisfies ListModelsOptions
    const model = {
      modelId: "Runtime/Exact.ID",
      name: "Runtime Exact ID",
      runtimeEfforts: [runtimeEffort],
      baselineEffort: runtimeEffort,
    } satisfies ModelWithEfforts
    const modelWithoutOptions = {
      modelId: "Runtime/No-Options.ID",
      name: "Runtime No Options ID",
      runtimeEfforts: [],
    } satisfies ModelWithEfforts
    const parsed = {
      runtimeEfforts: [runtimeEffort],
      baselineEffort: runtimeEffort,
    } satisfies EffortOptionsResult

    expect(options.cwd).toBe("/runtime-catalog")
    expect(model.modelId).toBe("Runtime/Exact.ID")
    expect(modelWithoutOptions.runtimeEfforts).toEqual([])
    expect(parsed).toEqual({
      runtimeEfforts: [runtimeEffort],
      baselineEffort: runtimeEffort,
    })
  })
})

describe("./ipc subpath", () => {
  test("exposes createIPCServer as a function", () => {
    expect(typeof ipc.createIPCServer).toBe("function")
  })

  test("package.json maps the ./ipc subpath for import and require", () => {
    const pkg = JSON.parse(
      readFileSync(join(import.meta.dir, "..", "package.json"), "utf-8"),
    ) as { exports: Record<string, { import?: string; require?: { default?: string } }> }

    expect(pkg.exports["./ipc"]).toBeDefined()
    expect(pkg.exports["./ipc"].import).toBe("./dist/ipc.js")
    expect(pkg.exports["./ipc"].require?.default).toBe("./dist/ipc.cjs")
  })
})
