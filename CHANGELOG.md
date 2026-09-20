# Changelog

All notable changes to `kiro-acp-ai-provider` are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and
the project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

This file was introduced after 3.1.0 was published; the 3.1.0 entry below is
retroactive and earlier releases are recorded by their git tags only.

## [Unreleased]

### Added

- History sync (`src/history-sync.ts`): the provider tracks which messages
  each kiro session has received, keyed by `x-session-affinity`, and sends
  only the new tail of the conversation on each call. Divergence (compaction,
  edited or reverted history, fork, cleared kiro session, unknown state)
  creates a new kiro session and replays the full history with tool calls
  and results. The system prompt is sent once per kiro session as
  `<system_instructions>` and again only on change as `<system-update>`.
- The delivered prefix is persisted next to the session mapping
  (`delivered`, `systemHash` in the session file), so a host restart
  continues the same kiro session without a replay.
- `KIRO_ACP_DEBUG_FILE` now also logs one record per dispatched prompt
  (`mode`, `newSession`, block sizes and a 200-char head).
- `providerMetadata.kiro.compaction = { at, status, error }` on the finish
  following a kiro-side `_kiro.dev/compaction/status`. `ACPClient.takeCompaction`
  and `ACPClient.onSessionInvalidated` expose the two signals.
- `mapStopReason`: `refusal` → `content-filter`, `max_turn_requests` → `stop`.
- Agent configs and tools files carry `pid`; on start the provider removes
  files whose process is dead or that are older than 24h (was 7 days, age
  only).
- `test/integration/compaction-roundtrip.ts`: real kiro-cli proof that the
  turn after an OpenCode-style compaction still has the compacted context.

### Changed

- A first call carrying assistant history no longer triggers a header-level
  reset; the delivered-prefix tracking decides. `x-session-reset` is still
  honoured as a forced replay.
- A call without `x-session-affinity` replays the full history into a
  one-shot session instead of sending only the last user message.
- Replay text uses `[User]`, `[Assistant]`, `[Assistant tool call]` and
  `[Tool result]` labels; the `<context>` wrapper is gone.

### Removed

- `extractPrompt` and `formatConversationReplay` in `src/kiro-acp-model.ts`,
  replaced by `src/prompt-serializer.ts`.

## [3.2.0] - 2026-09-04

### Added

- `stall` provider setting (`{ afterMs?, live? }`): detects when kiro-cli goes
  silent during a turn, which is what an overloaded backend looks like while
  kiro-cli retries. `afterMs` defaults to `10_000`; `0` disables the watchdog.
  With the default `live: "reasoning"`, the stream carries a short reasoning
  fragment while the turn is stalled (a notice when the silence threshold is
  reached, refreshed at each further threshold, and a closing line: "output
  resumed after Ns" once output arrives, or "turn ended after Ns without
  further output" if the turn ends first); `live: "off"` streams nothing.
- `providerMetadata.kiro.status = { stalledMs, hint? }` on the turn's final
  `text-end` or `reasoning-end`, next to the credits, whenever the turn
  stalled. `stalledMs` is the total time the turn spent stalled; `hint` is the
  most recent ERROR line `kiro-cli` wrote to its own chat log during the turn
  (ANSI-stripped, truncated), present only when the log is readable.
- `providerMetadata.kiro.turnWallMs` on the `finish` part: wall-clock time
  from sending the prompt until the finish event, measured by the provider.
  It sits next to kiro-cli's own `turnDurationMs`, which is unchanged. The
  `kiro` object is now always present on `finish`; when `kiro-cli` reports no
  session metadata it contains `turnWallMs` only.

### Changed

- The `kiro-cli settings mcp.noInteractiveTimeout` call made when a client
  starts no longer blocks the event loop and runs once per process for each
  distinct `mcpTimeout` value instead of on every start.

### Fixed

- `stop()` now releases the IPC server, tools file, pending requests and
  session state even when the `kiro-cli` process has already exited or
  crashed; previously an early return left them behind. It remains safe to
  call more than once.
- The per-instance agent config written to `.kiro/agents/` is removed when the
  client stops, and configs left behind by earlier crashed processes
  (`opencode-*.json` older than 7 days) are swept when a new one is written.

## [3.1.1] - 2026-09-03

### Changed

- Documentation-only release: the published README now documents
  `verifyAuthAsync()`, lists the `effort`, `efforts` and `contextWindows`
  provider settings, and states the supported Node.js version (20+, matching
  `engines.node`).
- `verifyAuthAsync()` carries an `@since 3.1.0` tag; its JSDoc no longer
  references an internal cache-reset helper.
- No runtime changes.

## [3.1.0] - 2026-09-02

### Added

- `verifyAuthAsync()`: a non-blocking twin of `verifyAuth()`. It runs the same
  `kiro-cli --version` and `kiro-cli whoami` probe and returns the same
  `AuthStatus`, but the two spawns never block the event loop. It shares the
  short-TTL result cache and the per-command timeouts with `verifyAuth()`,
  coalesces concurrent callers onto one in-flight probe, and never rejects: a
  missing `kiro-cli` resolves to `{ installed: false, authenticated: false }` and
  a failing or timed-out `whoami` resolves to `authenticated: false`.
- `engines.node` now declares the supported Node.js floor as `>=20`.

## [3.0.0] - 2026-07-18

See the [v3.0.0 tag](https://github.com/NachoFLizaur/kiro-acp-ai-provider/releases/tag/v3.0.0)
and its commit history for the changes in this release.

[3.2.0]: https://github.com/NachoFLizaur/kiro-acp-ai-provider/compare/v3.1.1...v3.2.0
[3.1.1]: https://github.com/NachoFLizaur/kiro-acp-ai-provider/compare/v3.1.0...v3.1.1
[3.1.0]: https://github.com/NachoFLizaur/kiro-acp-ai-provider/compare/v3.0.0...v3.1.0
[3.0.0]: https://github.com/NachoFLizaur/kiro-acp-ai-provider/releases/tag/v3.0.0
