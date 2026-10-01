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
  stall: {                        // Stall watchdog (see Stall detection below)
    afterMs: 10_000,              // Silence threshold in ms (default: 10_000; 0 disables)
    live: "reasoning",            // "reasoning" (default) shows a live notice while stalled; "off" shows nothing
  },
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

The `x-session-reset: true` header clears the persisted session and creates a fresh kiro session. The full conversation history is replayed as `<context>` text in a single message, since ACP doesn't support native fork/truncate. The replay needs at least one assistant or tool message in the prompt; a prompt that contains only user messages (for example a host compaction checkpoint) is sent using only the latest user message, without replaying earlier history (see Known limitations in the changelog). This enables revert-to-message and fork operations in consumers like [opencode](https://opencode.ai).

### MCP Timeout

On startup, the provider sets `mcp.noInteractiveTimeout` to 30 minutes via `kiro-cli settings`. The default 5 minutes is too short for long-running tool calls (e.g., subagents that run for 8+ minutes). The setting is applied once per process for each distinct `mcpTimeout` value and does not block the event loop.

### Stall detection

When the model backend is overloaded, `kiro-cli` retries silently and the stream can go quiet for a long time with no indication of what is happening. The `stall` setting turns that silence into a visible signal:

```typescript
const kiro = createKiroAcp({
  stall: {
    afterMs: 10_000,    // default; a turn counts as stalled after 10s without output
    live: "reasoning",  // default; set to "off" to keep the transcript clean
  },
})
```

- **`afterMs`** (default `10_000`): how long `kiro-cli` may stay silent during a turn before it counts as stalled. The timer starts when the prompt (or a batch of tool results) is sent, resets on every update from `kiro-cli`, and is cleared when the turn finishes, errors, or hands tool calls back to your application. `0` turns stall detection off entirely: no live notice and no `status` field in the provider metadata described below.
- **`live`** (default `"reasoning"`): with `"reasoning"`, the provider streams a small reasoning fragment (separate from the model's own reasoning) while the turn is stalled. It opens with a notice that no output has arrived for the configured time and that kiro-cli is likely retrying, adds a line at each further `afterMs` of silence, and closes with a line reporting how long the stall lasted: `output resumed after Ns` once real output arrives, or `turn ended after Ns without further output` if the turn ends first. When the kiro-cli log hint described below yields a short reason, the closing line ends with it in parentheses, for example `output resumed after 24s (ModelOverloaded)`. With `"off"`, nothing is streamed; the stall is only recorded in the metadata described next.

Whenever a turn stalled (regardless of `live`), the turn's final `text-end` or `reasoning-end` part carries `providerMetadata.kiro.status` next to the credits:

```typescript
providerMetadata.kiro.status = {
  stalledMs: number, // total time the turn spent stalled, in ms
  hint?: string,     // most recent ERROR line from kiro-cli's own chat log during this turn
  reason?: string,   // short reason from the full log line, e.g. "ModelOverloaded" (since 3.3.0)
}
```

`hint` is best-effort: it is read from kiro-cli's log file (`kiro-log/kiro-chat.log` in the OS temp directory), ANSI-stripped and truncated to about 160 characters, and is omitted when the log is missing or unreadable. It never blocks or fails the stream.

`reason` is derived by `stallReason` from the full ANSI-stripped, whitespace-collapsed kiro-cli ERROR log line before `hint` is truncated. It prefers the `kind:` value (`kind: ModelOverloadedError`), otherwise the first error-kind-like word (`ConverseStreamError`), and drops a trailing `Error`, giving `ModelOverloaded` and `ConverseStream`. It is omitted when no qualifying log line is available or no reason can be derived. `stallReason` is also exported for your own use, but calling `stallReason(hint)` on the displayed, truncated hint may return a different reason or `undefined`. The same captured reason is used in the closing line of the live notice.

Separately from stalls, every `finish` part reports the provider's own wall-clock measurement of the turn:

```typescript
providerMetadata.kiro.turnWallMs // ms from sending the prompt until finish, always present
providerMetadata.kiro.turnDurationMs // kiro-cli's own figure, passed through unchanged (null when not reported)
```

When `kiro-cli` reports no session metadata for a turn, the `kiro` object on `finish` contains `turnWallMs` only.

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

// Skip the short-lived memo and probe kiro-cli again (since 3.3.0)
const freshStatus = await verifyAuthAsync({ fresh: true })

// Discover exact runtime model IDs and their effort options
const models = await listModels({ cwd: process.cwd() })

// Get per-session credit usage
const quota = await getQuota({ client: kiro.getClient() })
```

`verifyAuth()` determines authentication solely from `kiro-cli whoami`, which abstracts the per-OS credential store. The on-disk SSO token file and its expiry are not consulted for the auth decision, so a stale token file never misreports a logged-in user. The returned `tokenPath` is provided only as an optional refresh hint for consumers.

`verifyAuthAsync()` runs the same probe and returns the same `AuthStatus`, but the two `kiro-cli` invocations (`--version` and `whoami`) run without blocking the event loop. Prefer it anywhere a stalled event loop would be visible, such as an interactive host, a login poll, or a server request handler; `verifyAuth()` remains available for callers that need a synchronous answer. Both functions share one short-TTL result cache and the same per-command timeouts, so mixing them is safe, and concurrent `verifyAuthAsync()` calls coalesce onto a single in-flight probe. `verifyAuthAsync()` never rejects: a missing `kiro-cli` resolves to `{ installed: false, authenticated: false }`, and a failing or timed-out `whoami` resolves to `authenticated: false`.

`verifyAuthAsync({ fresh: true })` (since 3.3.0) skips a warm memo and runs a new probe, for callers that need to notice a logout that happened after the memo was filled. A probe already in flight is joined rather than duplicated, and the result replaces the shared memo, so a following default call on either path reads it. Without options the behavior is unchanged.

`AuthStatus.inconclusive` (since 3.3.0, always `true` when present) tells you that `authenticated: false` is a default rather than evidence: kiro-cli is installed, but the `whoami` probe timed out or could not be spawned at all (an error such as `ENOENT` or `EACCES` with no exit status). It is absent whenever kiro-cli answered, including a non-zero exit that still printed output, and on every `installed: false` result. Consumers that act on a logout (for example by removing stored credentials) should ignore inconclusive results and probe again later. The `--version` step is unaffected: a timeout there still means `installed: true` and `whoami` decides, and any other failure still means `installed: false`.

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

Two errors mean "kiro-cli is not logged in" and carry a stable marker (since 3.3.0) so you can match on it instead of on the message text: the `KiroACPError` raised when `initialize` or `session/new` times out while `whoami` reports logged out (`Not logged in. Run 'kiro-cli login' to authenticate.`), and the `-32603` error described above once `whoami` corroborates the logout. Both have `data.reason === KIRO_NOT_LOGGED_IN_REASON` (`"not-logged-in"`). The marker is attached only when `kiro-cli whoami` answered logged out. If the probe is inconclusive, kiro-cli is missing, or `whoami` reports logged in, the generic error is kept without a marker.

Handle streaming errors with `onError` and consume the stream; `streamText` returns a result object, not a promise for the completed response:

```typescript
import { streamText } from "ai"
import { isKiroNotLoggedInError } from "kiro-acp-ai-provider"

const result = streamText({
  model: kiro("claude-sonnet-4.6"),
  prompt,
  onError({ error }) {
    if (isKiroNotLoggedInError(error)) {
      console.error("Run kiro-cli login before retrying.")
    } else {
      console.error(error)
    }
  },
})

await result.consumeStream()
```

`isKiroNotLoggedInError(value)` checks `value.data.reason` first, then falls back to the provider's own not-logged-in phrases on a string or on any `{ message }` value. The fallback matters when a host re-wraps errors as plain `Error` objects, which keeps the message but drops `data`. It never throws and returns `false` for anything else, including timeouts and other `-32603` failures.

## License

[MIT](./LICENSE) © Nacho F. Lizaur
