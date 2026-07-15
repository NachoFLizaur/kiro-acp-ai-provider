# Contributing

Thanks for helping improve `kiro-acp-ai-provider`. This is a small, single-maintainer library, so contributions are kept lightweight.

## Reporting bugs and requesting features

- Search [existing issues](https://github.com/NachoFLizaur/kiro-acp-ai-provider/issues) first.
- Open a bug report or feature request using the issue templates.
- For bugs, include your package version, runtime (Node or Bun) and version, `kiro-cli` version, and OS.

## Dev setup

Requires [Bun](https://bun.sh).

```bash
git clone https://github.com/NachoFLizaur/kiro-acp-ai-provider.git
cd kiro-acp-ai-provider
bun install
```

## Commands

```bash
bun run build      # build with tsup (bridge config, then main)
bun test           # run the test suite
bun run typecheck  # tsc --noEmit
```

Run `bun run typecheck` and `bun test` before opening a PR.

## Pull requests

- Link the issue your PR addresses (for example `Fixes #123`).
- Keep PRs small and focused on one change.
- Make sure `bun test` and `bun run typecheck` pass.
- Explain what changed and how you verified it.

Behavioral changes to the effort or model mapping (`src/kiro-effort.ts`, `src/kiro-models.ts`) must include a test.

## Commit style

Use conventional commit titles, title only (no long body required):

- `feat:` new functionality
- `fix:` bug fix
- `docs:` documentation
- `chore:` maintenance
- `refactor:` no behavior change
- `test:` tests

Example: `fix: reset reasoning effort to model default`.
