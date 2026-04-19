#!/usr/bin/env bun

/**
 * Integration test: Verify MCP bridge tool registration and isolation.
 *
 * Connects to a real kiro-cli process (must be installed and authenticated)
 * and exercises:
 *   Test 1 — Single session with write/edit/read/glob/grep tools.
 *            Sends a prompt requiring the `write` tool and verifies the model
 *            calls `write` (not `bash` or `task`).
 *   Test 2 — Concurrent sessions with different tool sets.
 *            Creates a "parent" session with bash/task/read/glob, then a
 *            "subagent" session with read/write/edit/glob/grep. Verifies
 *            the subagent sees `write` in its tools, not `bash`/`task`.
 *
 * This is critical for diagnosing why `write` and `edit` tools aren't
 * visible to the model when opencode spawns subagent sessions.
 *
 * Run:  bun test/integration/tool-verification.ts
 */

import { createKiroAcp, type KiroACPProvider } from "../../src/index"
import type {
  LanguageModelV3,
  LanguageModelV3CallOptions,
  LanguageModelV3FunctionTool,
  LanguageModelV3StreamPart,
} from "@ai-sdk/provider"

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MODEL_ID = "claude-sonnet-4.6"

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

/** Subagent tools — includes write and edit (the tools we're verifying). */
const SUBAGENT_TOOLS: LanguageModelV3FunctionTool[] = [
  {
    type: "function",
    name: "read",
    description: "Read a file",
    inputSchema: {
      type: "object",
      properties: { filePath: { type: "string" } },
      required: ["filePath"],
    },
  },
  {
    type: "function",
    name: "write",
    description: "Write a file",
    inputSchema: {
      type: "object",
      properties: {
        filePath: { type: "string" },
        content: { type: "string" },
      },
      required: ["filePath", "content"],
    },
  },
  {
    type: "function",
    name: "edit",
    description: "Edit a file",
    inputSchema: {
      type: "object",
      properties: {
        filePath: { type: "string" },
        old: { type: "string" },
        new: { type: "string" },
      },
      required: ["filePath", "old", "new"],
    },
  },
  {
    type: "function",
    name: "glob",
    description: "Find files",
    inputSchema: {
      type: "object",
      properties: { pattern: { type: "string" } },
      required: ["pattern"],
    },
  },
  {
    type: "function",
    name: "grep",
    description: "Search files",
    inputSchema: {
      type: "object",
      properties: { pattern: { type: "string" } },
      required: ["pattern"],
    },
  },
]

/** Parent agent tools — does NOT include write or edit. */
const PARENT_TOOLS: LanguageModelV3FunctionTool[] = [
  {
    type: "function",
    name: "bash",
    description: "Run a command",
    inputSchema: {
      type: "object",
      properties: { command: { type: "string" } },
      required: ["command"],
    },
  },
  {
    type: "function",
    name: "task",
    description: "Create a task",
    inputSchema: {
      type: "object",
      properties: { description: { type: "string" } },
      required: ["description"],
    },
  },
  {
    type: "function",
    name: "read",
    description: "Read a file",
    inputSchema: {
      type: "object",
      properties: { filePath: { type: "string" } },
      required: ["filePath"],
    },
  },
  {
    type: "function",
    name: "glob",
    description: "Find files",
    inputSchema: {
      type: "object",
      properties: { pattern: { type: "string" } },
      required: ["pattern"],
    },
  },
]

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function separator(char = "─", width = 55): string {
  return char.repeat(width)
}

function banner(title: string): string {
  const line = "═".repeat(55)
  return `\n${line}\n  ${title}\n${line}`
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// ---------------------------------------------------------------------------
// Stream consumer — reads all parts and collects tool calls + text
// ---------------------------------------------------------------------------

interface StreamResult {
  toolCalls: Array<{ toolName: string; args: Record<string, unknown> }>
  textOutput: string
  finishReason: string | null
  error: string | null
}

async function consumeStream(
  stream: ReadableStream<LanguageModelV3StreamPart>,
): Promise<StreamResult> {
  const reader = stream.getReader()
  const toolCalls: Array<{ toolName: string; args: Record<string, unknown> }> = []
  const textParts: string[] = []
  let finishReason: string | null = null
  let error: string | null = null

  // Accumulate tool input deltas by id
  const toolInputBuffers = new Map<string, { toolName: string; input: string }>()

  for (;;) {
    const { done, value } = await reader.read()
    if (done) break

    switch (value.type) {
      case "text-delta":
        textParts.push(value.delta)
        process.stdout.write(value.delta)
        break

      case "tool-input-start":
        toolInputBuffers.set(value.id, { toolName: value.toolName, input: "" })
        break

      case "tool-input-delta": {
        const buf = toolInputBuffers.get(value.id)
        if (buf) buf.input += value.delta
        break
      }

      case "tool-call": {
        let args: Record<string, unknown> = {}
        try {
          args = JSON.parse(value.input) as Record<string, unknown>
        } catch {
          // input may not be valid JSON in edge cases
        }
        toolCalls.push({ toolName: value.toolName, args })
        console.log(`[Stream] Tool call: ${value.toolName}(${JSON.stringify(args)})`)
        break
      }

      case "finish":
        finishReason = value.finishReason.unified
        break

      case "error":
        error = value.error instanceof Error ? value.error.message : String(value.error)
        console.error(`[Stream] Error: ${error}`)
        break
    }
  }

  if (textParts.length > 0) {
    // Newline after streamed text
    process.stdout.write("\n")
  }

  return { toolCalls, textOutput: textParts.join(""), finishReason, error }
}

// ---------------------------------------------------------------------------
// Test 1: Single session — verify write tool is visible
// ---------------------------------------------------------------------------

async function test1SingleSession(): Promise<boolean> {
  console.log(banner("Test 1: Single session - write tool"))

  let provider: KiroACPProvider | null = null

  try {
    console.log("[Setup] Creating provider and model...")
    provider = createKiroAcp({
      cwd: "/Users/nflizaur/Documents/5-coding/open-source/opencode",
      agent: "test-tools",
      trustAllTools: true,
    })
    const model = provider(MODEL_ID)

    const toolNames = SUBAGENT_TOOLS.map((t) => t.name).join(", ")
    console.log(`[Setup] Tools: ${toolNames}`)

    const options: LanguageModelV3CallOptions = {
      prompt: [
        {
          role: "system",
          content:
            "You are a helpful assistant. When asked to create a file, use the write tool. " +
            "Do NOT use bash or any other tool. Only use the write tool.",
        },
        {
          role: "user",
          content: [
            {
              type: "text",
              text: "Create a file at /tmp/test-kiro-write.txt with content 'Hello from kiro'. Use the write tool.",
            },
          ],
        },
      ],
      tools: SUBAGENT_TOOLS,
      headers: { "x-session-affinity": "test-single-write" },
    }

    console.log('[Prompt] "Create a file at /tmp/test-kiro-write.txt..."')

    const result = await model.doStream(options)
    const streamResult = await consumeStream(result.stream)

    // Evaluate
    const usedWrite = streamResult.toolCalls.some((tc) => tc.toolName === "write")
    const usedBash = streamResult.toolCalls.some((tc) => tc.toolName === "bash")
    const usedTask = streamResult.toolCalls.some((tc) => tc.toolName === "task")

    if (usedWrite && !usedBash && !usedTask) {
      console.log("[Result] ✅ Model used 'write' tool correctly")
      return true
    } else if (usedBash || usedTask) {
      console.log(
        `[Result] ❌ Model used wrong tool(s): ${streamResult.toolCalls.map((tc) => tc.toolName).join(", ")}`,
      )
      console.log("[Result]    Expected 'write' but got bash/task — tool registration may be broken")
      return false
    } else if (streamResult.toolCalls.length === 0) {
      console.log("[Result] ❌ Model made no tool calls at all")
      console.log(`[Result]    Text output: ${streamResult.textOutput.slice(0, 200)}`)
      return false
    } else {
      console.log(
        `[Result] ⚠️  Model used unexpected tool(s): ${streamResult.toolCalls.map((tc) => tc.toolName).join(", ")}`,
      )
      return false
    }
  } finally {
    if (provider) {
      try {
        await provider.shutdown()
      } catch {
        // Ignore shutdown errors
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Test 2: Concurrent sessions — verify tool isolation
// ---------------------------------------------------------------------------

async function test2ConcurrentSessions(): Promise<boolean> {
  console.log(banner("Test 2: Concurrent sessions - tool isolation"))

  let parentProvider: KiroACPProvider | null = null
  let subagentProvider: KiroACPProvider | null = null

  try {
    // --- Parent session ---
    const parentToolNames = PARENT_TOOLS.map((t) => t.name).join(", ")
    console.log(`[Setup] Creating parent session with tools: ${parentToolNames}`)

    parentProvider = createKiroAcp({
      cwd: "/Users/nflizaur/Documents/5-coding/open-source/opencode",
      agent: "test-tools",
      trustAllTools: true,
    })
    const parentModel = parentProvider(MODEL_ID)

    console.log("[Parent] Sending prompt to establish parent session...")

    const parentOptions: LanguageModelV3CallOptions = {
      prompt: [
        {
          role: "system",
          content: "You are a helpful assistant. Reply briefly.",
        },
        {
          role: "user",
          content: [
            {
              type: "text",
              text: "Say 'parent session established' and nothing else.",
            },
          ],
        },
      ],
      tools: PARENT_TOOLS,
      headers: { "x-session-affinity": "test-parent-session" },
    }

    const parentResult = await parentModel.doStream(parentOptions)
    const parentStream = await consumeStream(parentResult.stream)
    console.log(`[Parent] Response: ${parentStream.textOutput.slice(0, 100)}`)
    console.log(separator())

    // Small delay to let sessions settle
    await sleep(500)

    // --- Subagent session ---
    const subagentToolNames = SUBAGENT_TOOLS.map((t) => t.name).join(", ")
    console.log(`[Setup] Creating subagent session with tools: ${subagentToolNames}`)

    subagentProvider = createKiroAcp({
      cwd: "/Users/nflizaur/Documents/5-coding/open-source/opencode",
      agent: "test-tools",
      trustAllTools: true,
    })
    const subagentModel = subagentProvider(MODEL_ID)

    console.log("[Subagent] Sending prompt requiring 'write' tool...")

    const subagentOptions: LanguageModelV3CallOptions = {
      prompt: [
        {
          role: "system",
          content:
            "You are a helpful assistant. When asked to create a file, use the write tool. " +
            "Do NOT use bash or any other tool. Only use the write tool.",
        },
        {
          role: "user",
          content: [
            {
              type: "text",
              text: "Create a file at /tmp/test-kiro-isolation.txt with content 'Isolated write'. Use the write tool.",
            },
          ],
        },
      ],
      tools: SUBAGENT_TOOLS,
      headers: { "x-session-affinity": "test-subagent-session" },
    }

    const subagentResult = await subagentModel.doStream(subagentOptions)
    const subagentStream = await consumeStream(subagentResult.stream)

    // Evaluate
    const usedWrite = subagentStream.toolCalls.some((tc) => tc.toolName === "write")
    const usedBash = subagentStream.toolCalls.some((tc) => tc.toolName === "bash")
    const usedTask = subagentStream.toolCalls.some((tc) => tc.toolName === "task")

    if (usedWrite && !usedBash && !usedTask) {
      console.log("[Result] ✅ Subagent used 'write' tool correctly (tool isolation works)")
      return true
    } else if (usedBash || usedTask) {
      console.log(
        `[Result] ❌ Subagent used parent's tool(s): ${subagentStream.toolCalls.map((tc) => tc.toolName).join(", ")}`,
      )
      console.log("[Result]    Tool isolation is BROKEN — subagent sees parent's tools")
      return false
    } else if (subagentStream.toolCalls.length === 0) {
      console.log("[Result] ❌ Subagent made no tool calls at all")
      console.log(`[Result]    Text output: ${subagentStream.textOutput.slice(0, 200)}`)
      return false
    } else {
      console.log(
        `[Result] ⚠️  Subagent used unexpected tool(s): ${subagentStream.toolCalls.map((tc) => tc.toolName).join(", ")}`,
      )
      return false
    }
  } finally {
    // Shut down both providers
    const shutdowns: Promise<void>[] = []
    if (parentProvider) {
      shutdowns.push(parentProvider.shutdown().catch(() => {}))
    }
    if (subagentProvider) {
      shutdowns.push(subagentProvider.shutdown().catch(() => {}))
    }
    await Promise.all(shutdowns)
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log(separator("═"))
  console.log("  MCP Bridge Tool Verification")
  console.log("  Verifies tools are correctly registered and isolated")
  console.log(separator("═"))

  const results: Array<{ name: string; passed: boolean }> = []

  try {
    // Test 1
    const test1Passed = await test1SingleSession()
    results.push({ name: "Single session - write tool", passed: test1Passed })

    // Small gap between tests
    await sleep(1000)

    // Test 2
    const test2Passed = await test2ConcurrentSessions()
    results.push({ name: "Concurrent sessions - tool isolation", passed: test2Passed })
  } catch (error) {
    console.error("\n💥 Test suite failed with error:")
    console.error(error)
    process.exit(1)
  }

  // Summary
  console.log(banner("Summary"))

  let allPassed = true
  for (const result of results) {
    const icon = result.passed ? "✅" : "❌"
    console.log(`  ${icon} ${result.name}`)
    if (!result.passed) allPassed = false
  }

  console.log(separator("═"))

  if (allPassed) {
    console.log("\n🎉 All tool verification tests passed!\n")
  } else {
    console.log("\n⚠️  Some tests failed. MCP bridge tool registration may be broken.\n")
    process.exit(1)
  }
}

main()
