# kiro-acp-ai-provider

[Kiro](https://kiro.dev) provider for the [Vercel AI SDK](https://sdk.vercel.ai/) that uses `kiro-cli` via the [Agent Client Protocol (ACP)](https://docs.kiro.dev/acp). Implements `LanguageModelV3` with streaming and tool calling.

## Install

```bash
npm install kiro-acp-ai-provider @ai-sdk/provider
```

> **Note**: Your application also needs the `ai` package (Vercel AI SDK). Install it separately if you haven't already:
> ```bash
> npm install ai
> ```

## Prerequisites

- **Node.js 20+** (enforced via `engines.node`) or **Bun**
- **kiro-cli** installed and authenticated:
  ```bash
  kiro-cli login
  ```
- **Kiro subscription** (Pro, Pro+, Pro Max, or Power)

## Quick Start

```typescript
import { createKiroAcp } from "kiro-acp-ai-provider"
import { streamText } from "ai"

const kiro = createKiroAcp({ cwd: process.cwd() })

const result = streamText({
  model: kiro("claude-sonnet-4.6"),
  prompt: "Write a hello world function in TypeScript",
})

for await (const text of result.textStream) {
  process.stdout.write(text)
}

await kiro.shutdown()
```

## How it works

```
Your App → AI SDK → kiro-acp-ai-provider → kiro-cli (ACP) → AWS Models
                          ↕ IPC (HTTP)
                    MCP Bridge (per-session)
```

The provider translates AI SDK calls into ACP messages sent to a `kiro-cli` subprocess over JSON-RPC stdio. Tool calls are relayed through an MCP bridge back to your application via IPC. The bridge does **not** execute tools, your application does.

## Configuration

```typescript
const kiro = createKiroAcp({
  cwd: "/path/to/project",        // Working directory (default: process.cwd())
  model: "claude-sonnet-4.6",     // Default model ID
  agent: "my-agent",              // Custom agent name (--agent flag)
  trustAllTools: true,            // Auto-approve all tool calls
  agentPrompt: "You are a ...",   // Custom system prompt
  contextWindow: 200_000,         // Max context window in tokens (default: 1_000_000)
  contextWindows: {               // Per-model context windows keyed by model ID;
    "claude-sonnet-4.6": 200_000, // takes precedence over contextWindow for that model
  },
  effort: "high",                 // Reasoning effort for every model from this provider
  efforts: {                      // Per-model reasoning effort keyed by model ID;
    "claude-sonnet-4.6": "low",   // takes precedence over effort for that model
  },
  mcpTimeout: 30,                 // MCP tool call timeout in minutes (default: 30)
  sessionId: "previous-id",       // Resume an existing session
  env: { MY_VAR: "value" },       // Extra env vars for kiro-cli
  clientInfo: { name: "my-app", version: "1.0.0" },
  onPermission: (request) => ({   // Custom permission handler
    outcome: { outcome: "selected", optionId: "allow_once" },
  }),
})
```

## Session Management

### Subagent Process Isolation

When the provider receives an `x-parent-session-id` header (indicating a subagent/child session), it spawns a **separate kiro-cli process** for that session. This prevents tool definitions from leaking between parent and child sessions. Isolated processes are auto-cleaned after 3 minutes idle.

### Session Reset (Revert / Fork)

The `x-session-reset: true` header clears the persisted session and creates a fresh kiro session. The full conversation history is replayed as `<context>` text in a single message, since ACP doesn't support native fork/truncate. This enables revert-to-message and fork operations in consumers like [opencode](https://opencode.ai).

### MCP Timeout

On startup, the provider sets `mcp.noInteractiveTimeout` to 30 minutes via `kiro-cli settings`. The default 5 minutes is too short for long-running tool calls (e.g., subagents that run for 8+ minutes).

## Provider Methods

```typescript
const model = kiro("claude-sonnet-4.6")     // Create a LanguageModelV3
const model = kiro.languageModel("claude-sonnet-4.6")  // Same thing

await kiro.shutdown()                        // Stop kiro-cli process
kiro.getClient()                             // Get underlying ACPClient
kiro.getSessionId()                          // Get session ID for persistence
await kiro.injectContext(summary)            // Rehydrate session context
kiro.getTotalCredits()                       // Total credits consumed
```

## Utilities

Standalone functions that don't require a running provider:

```typescript
import { verifyAuth, verifyAuthAsync, listModels, getQuota } from "kiro-acp-ai-provider"

// Check if kiro-cli is installed and authenticated
const status = verifyAuth()
// { installed: true, authenticated: true, version: "1.2.3", tokenPath: "..." }

// Same check without blocking the event loop
const asyncStatus = await verifyAuthAsync()

// Discover exact runtime model IDs and their effort options
const models = await listModels({ cwd: process.cwd() })

// Get per-session credit usage
const quota = await getQuota({ client: kiro.getClient() })
```

`verifyAuth()` determines authentication solely from `kiro-cli whoami`, which abstracts the per-OS credential store. The on-disk SSO token file and its expiry are not consulted for the auth decision, so a stale token file never misreports a logged-in user. The returned `tokenPath` is provided only as an optional refresh hint for consumers.

`verifyAuthAsync()` runs the same probe and returns the same `AuthStatus`, but the two `kiro-cli` invocations (`--version` and `whoami`) run without blocking the event loop. Prefer it anywhere a stalled event loop would be visible, such as an interactive host, a login poll, or a server request handler; `verifyAuth()` remains available for callers that need a synchronous answer. Both functions share one short-TTL result cache and the same per-command timeouts, so mixing them is safe, and concurrent `verifyAuthAsync()` calls coalesce onto a single in-flight probe. `verifyAuthAsync()` never rejects: a missing `kiro-cli` resolves to `{ installed: false, authenticated: false }`, and a failing or timed-out `whoami` resolves to `authenticated: false`.

## Models

Available models depend on the current Kiro runtime and subscription. `listModels()`
starts a temporary ACP client, returns runtime model IDs exactly as received, and
always stops the client. It checks each model serially by switching to that exact
ID and requesting its effort options, then best-effort restores the original model.

Every `ModelWithEfforts` owns a `runtimeEfforts` array. It contains validated opaque
values in runtime order, or `[]` when switching or option discovery is unavailable,
invalid, incomplete, or unsupported. `baselineEffort` is present only when the same
validated runtime response identifies one active value that belongs to that model's
`runtimeEfforts`. Raw model fields cannot spoof either effort field; other model
metadata is preserved.

## Reasoning effort

Reasoning effort values are opaque strings discovered at runtime. Pass a nonempty
value returned by `listModels()` unchanged through `providerOptions`, keyed by the
provider id `kiro`:

```typescript
const [runtimeModel] = await listModels({ cwd: process.cwd() })
const effort = runtimeModel?.runtimeEfforts[0]

if (runtimeModel && effort) {
  const result = streamText({
    model: kiro(runtimeModel.modelId),
    prompt: "Explain the tradeoffs",
    providerOptions: { kiro: { reasoningEffort: effort } },
  })
}
```

The same option works on `generateText`. You can explicitly configure a discovered
value at the provider level, in the per-model `efforts` map, or in a model override;
a nonempty per-request value wins. If neither the request nor configuration supplies
a nonempty effort, the SDK sends no effort command. Rejected values and effort-command
failures remain fail-soft and do not change the turn result.

## Tools

Tools work through the standard AI SDK contract. The provider includes an MCP bridge that reads tool definitions from a JSON file and relays calls to your application via IPC. Pass custom tools through the AI SDK as usual; the provider handles the MCP bridge plumbing.

## Image Support

The provider supports images in two paths:

### User-attached images

Images pasted in chat are sent as `ContentBlock[]` with the prompt via ACP's `session/prompt`. This is the native path: kiro-cli handles image optimization and the model sees them directly.

### Tool-returned images

When a tool (e.g., a file read tool) returns an image, the provider uses a follow-up prompt approach:

1. The tool result is sent via IPC as text-only (so the MCP bridge flow completes)
2. The first model response is aborted
3. A follow-up `session/prompt` is sent with the images as `ContentBlock[]`, including the original user request for context

This is necessary because kiro-cli's MCP tool result path doesn't reliably handle large images; sending them through the user-message path (`session/prompt`) ensures proper image processing.

> **Note**: The follow-up approach adds a small latency overhead (~1-2s) for tool results that contain images. Text-only tool results are unaffected.

## Known Limitations

- **System prompt**: Kiro's base context is always present; yours is injected via `<system_instructions>` tags
- **Limited per-turn options**: Temperature and similar sampling parameters are controlled by kiro-cli. Reasoning effort is the exception (see Reasoning effort)
- **Estimated token counts**: Input tokens estimated from context usage %, output from character count
- **Process model**: One kiro-cli per provider instance (subagent sessions get their own isolated process); concurrent sessions use lane routing
- **Revert-to-message**: Requires the consumer to signal session reset via `x-session-reset` header as Kiro ACP doesn't support Checkpointing.
- **No ACP session/fork**: Kiro ACP doesn't support native fork/truncate, so reverts replay the conversation history as context text
- **Reasoning**: Kiro always streams reasoning and it cannot be disabled. Effort is configurable per model (see Reasoning effort)
- **Tool-returned images**: Uses a follow-up prompt approach which adds ~1-2s latency and an extra synthetic message in kiro-cli's session history

## Errors

When kiro-cli returns a JSON-RPC `-32603` internal error and `kiro-cli whoami` reports you are logged out, the provider raises an actionable error asking you to re-authenticate with `kiro-cli login` (run `kiro-cli doctor` to help diagnose). Recent kiro-cli stderr is appended to the message to aid diagnosis.

## License

[MIT](./LICENSE) © Nacho F. Lizaur
