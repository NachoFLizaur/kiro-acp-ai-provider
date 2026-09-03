# Changelog

All notable changes to `kiro-acp-ai-provider` are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and
the project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

This file was introduced after 3.1.0 was published; the 3.1.0 entry below is
retroactive and earlier releases are recorded by their git tags only.

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

[3.1.1]: https://github.com/NachoFLizaur/kiro-acp-ai-provider/compare/v3.1.0...v3.1.1
[3.1.0]: https://github.com/NachoFLizaur/kiro-acp-ai-provider/compare/v3.0.0...v3.1.0
[3.0.0]: https://github.com/NachoFLizaur/kiro-acp-ai-provider/releases/tag/v3.0.0
