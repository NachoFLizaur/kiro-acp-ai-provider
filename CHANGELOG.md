# Changelog

All notable changes to `kiro-acp-ai-provider` are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and
the project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

This file was introduced after 3.1.0 was published; the 3.1.0 entry below is
retroactive and earlier releases are recorded by their git tags only.

## [3.3.0] - 2026-10-01

### Added

- `verifyAuthAsync({ fresh: true })`: skips a warm memo and runs a new
  `kiro-cli whoami` probe. A probe already in flight is joined rather than
  duplicated, and the result replaces the memo shared with the sync
  `verifyAuth()`, so a following default call on either path reads it.
  Without options `verifyAuthAsync()` behaves exactly as before (5s memo,
  coalescing, never rejects). The `VerifyAuthOptions` type is exported.
- `AuthStatus.inconclusive` (always `true` when present): set by both
  `verifyAuth()` and `verifyAuthAsync()` when kiro-cli is installed but the
  whoami probe could not answer, that is, it timed out or could not be spawned
  at all (an error such as `ENOENT` or `EACCES` with no exit status). In that
  case `authenticated: false` is a default rather than evidence, so consumers
  deciding on a logout should not treat it as one. It is absent when kiro-cli
  answered, including a non-zero exit that still printed output, and on every
  `installed: false` result. The `--version` step is unchanged: a timeout there
  still means `installed: true` and whoami decides, any other failure still
  means `installed: false`, and that step never sets `inconclusive`.
- `KIRO_NOT_LOGGED_IN_REASON` (`"not-logged-in"`) and
  `isKiroNotLoggedInError(value)`: a stable machine-readable marker for the
  provider's not-logged-in errors and a matcher for it. Two errors carry
  `data.reason === KIRO_NOT_LOGGED_IN_REASON`: the `KiroACPError` raised when
  `initialize` or `session/new` times out and `whoami` reports logged out, and
  the `KiroACPError` (code `-32603`) now emitted on the stream when a turn fails
  with `-32603` and `whoami` corroborates a logout (previously a plain `Error`
  with the same message). The matcher checks the marker first and falls back to
  the provider's own not-logged-in phrases on a string or any `{ message }`
  value, so it also works on errors a host has re-wrapped as plain `Error`. It
  never throws. The generic `-32603` mapping (whoami says logged in) carries no
  marker.
  The marker is now attached only when `kiro-cli whoami` answered logged out;
  an inconclusive probe (timeout or spawn failure) or a missing kiro-cli carries
  no marker and keeps the generic error.
- `stallReason(hint)`: derives a short reason from a stall hint (a kiro-cli
  ERROR log line). It prefers the `kind:` value when present (for example
  `kind: ModelOverloadedError`), otherwise the first error-kind-like word (for
  example `ConverseStreamError`), and drops a trailing `Error`, so both yield
  `ModelOverloaded` and `ConverseStream`. Returns `undefined` when no such token
  exists. Never throws.
- `providerMetadata.kiro.status.reason`: next to `stalledMs` and `hint`, the
  result of `stallReason` on the full ANSI-stripped, whitespace-collapsed kiro-cli
  ERROR log line before `hint` is truncated, present only when a reason can be
  derived. Calling `stallReason(hint)` on the displayed, truncated hint may return
  a different reason or `undefined`.

### Changed

- The stall notice's closing line now ends with the short reason in parentheses
  when one can be derived from the kiro-cli log hint: `output resumed after Ns
  (ModelOverloaded)` when output arrives again (whether as new text or as tool
  calls handed back to the application) and `turn ended after Ns without
  further output (ModelOverloaded)` when the turn ends first. Without a reason
  the wording is unchanged from 3.2.0.

### Fixed

- The requested effort is now applied to each ACP session before its prompt.
  Previously it was applied once per model instance, so later sessions, reloads
  and switching back to an earlier variant could run with kiro-cli's default effort.
  The selected model is likewise applied per session, so a non-default Kiro model
  no longer falls back to kiro-cli's default model on later sessions or after a restart.

### Known limitations

These issues are pre-existing, with fixes planned for the next release:

- After compaction or a history rewrite, the provider can start a fresh kiro-cli
  session without replaying earlier history when the prompt contains no assistant
  or tool messages (for example, a host checkpoint sent as a user message). The
  summary or next turn can then miss context.
- When a host sends a title or other auxiliary request concurrently with a main
  turn that has no tools, under the same session affinity, the saved kiro-cli
  session can end up pointing at the title or auxiliary request's session. Later
  turns can then lose context.

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

[3.3.0]: https://github.com/NachoFLizaur/kiro-acp-ai-provider/compare/v3.2.0...HEAD
[3.2.0]: https://github.com/NachoFLizaur/kiro-acp-ai-provider/compare/v3.1.1...v3.2.0
[3.1.1]: https://github.com/NachoFLizaur/kiro-acp-ai-provider/compare/v3.1.0...v3.1.1
[3.1.0]: https://github.com/NachoFLizaur/kiro-acp-ai-provider/compare/v3.0.0...v3.1.0
[3.0.0]: https://github.com/NachoFLizaur/kiro-acp-ai-provider/releases/tag/v3.0.0
