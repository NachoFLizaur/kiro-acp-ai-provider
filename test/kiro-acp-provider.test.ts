import { describe, expect, test } from "bun:test"
import { createKiroAcp } from "../src/kiro-acp-provider"

describe("createKiroAcp", () => {
  test("defaults to an MCP-capable custom agent", async () => {
    const provider = createKiroAcp()

    expect(provider.getClient().getOptions().agent).toBe("kiro-acp")
    await provider.shutdown()
  })

  test("preserves an explicitly configured agent", async () => {
    const provider = createKiroAcp({ agent: "custom-agent" })

    expect(provider.getClient().getOptions().agent).toBe("custom-agent")
    await provider.shutdown()
  })
})
