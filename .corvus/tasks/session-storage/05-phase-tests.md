# 05. Phase Tests — Session Storage + Reference Cleanup

## Meta
- **ID**: session-storage-05
- **Feature**: session-storage
- **Phase**: 1
- **Priority**: P1
- **Depends On**: [session-storage-01, session-storage-02, session-storage-03, session-storage-04]
- **Effort**: M (1.5h)
- **Tags**: [tests, phase-tests, unit]
- **Requires UX/DX Review**: false

## Objective
Write comprehensive tests for all implementation tasks: XDG session storage module, affinity header plumbing, and opencode reference cleanup.

## Context
This task creates tests for the following implementation tasks:
- Task 01: XDG session storage module — `src/session-storage.ts`
- Task 02: Affinity header plumbing — `x-session-affinity` extraction in `doStream()`
- Task 03: Opencode reference cleanup — `generateAgentConfig()` dynamic naming

Tests are designed from acceptance criteria, not implementation details.

**Note**: Tests are deferred (`tests_deferred: true`) — they are generated but not executed during Phase 4 quality gates. They run for the first time in Phase 5 final validation.

## Test Specifications

### Tests for Task 01: XDG Session Storage Module

**Source File(s)**: `src/session-storage.ts`
**Test File**: `test/session-storage.test.ts`

| Test Name | Type | Input | Expected Output | Validates |
|-----------|------|-------|-----------------|-----------|
| `getSessionFilePath returns XDG path with affinity ID` | unit | `cwd="/project", affinityId="abc123"` | Path ending in `sessions/{hash}/abc123.json` | "Path structure sessions/{cwdHash}/{affinityId}.json" |
| `getSessionFilePath returns _default.json without affinity` | unit | `cwd="/project", affinityId=undefined` | Path ending in `sessions/{hash}/_default.json` | "Fallback to _default.json" |
| `getSessionFilePath uses XDG_DATA_HOME when set` | unit | `env.XDG_DATA_HOME="/custom"` | Path starting with `/custom/kiro-acp-ai-provider/` | "XDG data directory" |
| `getSessionFilePath falls back to ~/.local/share` | unit | `env.XDG_DATA_HOME=undefined` | Path containing `.local/share/kiro-acp-ai-provider/` | "XDG fallback" |
| `persistSession + loadPersistedSession round-trip` | unit | Persist then load same cwd+affinity | Returns `{ kiroSessionId, lastUsed }` | "Minimal mapping per file" |
| `loadPersistedSession returns null for stale session` | unit | Session with lastUsed > 24h ago | `null` | "24h TTL staleness check" |
| `loadPersistedSession returns null for missing file` | unit | Non-existent path | `null` | "Graceful fallback" |
| `loadPersistedSession returns null for invalid JSON` | unit | File with garbage content | `null` | "Graceful fallback" |
| `persistSession creates directory tree` | unit | New cwd that hasn't been used | Directory created, file written | "mkdirSync recursive" |
| `persisted data contains only kiroSessionId and lastUsed` | unit | Persist then read raw file | JSON has exactly 2 keys | "No modelId in persisted data" |
| `different affinity IDs produce different files` | unit | Same cwd, different affinityIds | Different file paths | "Multi-session keying" |

**Mocking Requirements**:
- Use a temp directory for `XDG_DATA_HOME` to avoid writing to real `~/.local/share`
- Save/restore `process.env.XDG_DATA_HOME` around tests that modify it

---

### Tests for Task 02: Affinity Header Plumbing

**Source File(s)**: `src/kiro-acp-model.ts`
**Test File**: `test/kiro-acp-model.test.ts` (add to existing)

| Test Name | Type | Input | Expected Output | Validates |
|-----------|------|-------|-----------------|-----------|
| `doStream extracts x-session-affinity header` | unit | `options.headers = { "x-session-affinity": "sess-42" }` | `setAffinityId` called with `"sess-42"` | "Read x-session-affinity from options.headers" |
| `doStream uses undefined affinity when header missing` | unit | `options.headers = {}` | `setAffinityId` called with `undefined` | "Affinity mechanism is optional" |
| `doStream handles undefined headers object` | unit | `options.headers = undefined` | `setAffinityId` called with `undefined` | "Works without header" |

**Mocking Requirements**:
- Mock `ACPClient` methods (existing pattern in test file)
- Spy on `setAffinityId` or verify via session file path

---

### Tests for Task 03: Opencode Reference Cleanup

**Source File(s)**: `src/agent-config.ts`
**Test File**: `test/acp-client.test.ts` (add to existing, or inline in a new describe block)

| Test Name | Type | Input | Expected Output | Validates |
|-----------|------|-------|-----------------|-----------|
| `generateAgentConfig uses dynamic MCP server name` | unit | `{ name: "my-editor", ... }` | Config has `mcpServers["my-editor-tools"]` | "MCP server name derived from agent name" |
| `generateAgentConfig defaults to kiro-acp` | unit | `{ name: undefined, ... }` | Config has `name: "kiro-acp"` | "Default agent name is kiro-acp" |
| `generateAgentConfig default MCP server is kiro-acp-tools` | unit | `{ name: undefined, ... }` | Config has `mcpServers["kiro-acp-tools"]` | "Default MCP server name" |
| `generateAgentConfig system prompt is consumer-agnostic` | unit | Default options | Prompt does not contain "opencode" | "No opencode references" |
| `no opencode references in source files` | integration | `rg -i opencode src/` | Empty result | "Provider is consumer-agnostic" |

**Mocking Requirements**:
- None — `generateAgentConfig` is a pure function

---

## Files to Create

| Test File | Tests | For Task |
|-----------|-------|----------|
| `test/session-storage.test.ts` | 11 tests | Task 01 |
| `test/kiro-acp-model.test.ts` (additions) | 3 tests | Task 02 |
| `test/acp-client.test.ts` (additions) | 5 tests | Task 03 |

## Implementation Steps

### Step 1: Create `test/session-storage.test.ts`

Create a new test file for the session storage module:

```typescript
import { describe, test, expect, beforeEach, afterEach } from "bun:test"
import { mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { getSessionFilePath, persistSession, loadPersistedSession } from "../src/session-storage"

describe("session-storage", () => {
  let testDir: string
  let originalXdgDataHome: string | undefined

  beforeEach(() => {
    // Use a unique temp dir for each test
    testDir = join(tmpdir(), `session-storage-test-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    mkdirSync(testDir, { recursive: true })
    originalXdgDataHome = process.env.XDG_DATA_HOME
    process.env.XDG_DATA_HOME = testDir
  })

  afterEach(() => {
    // Restore env and clean up
    if (originalXdgDataHome !== undefined) {
      process.env.XDG_DATA_HOME = originalXdgDataHome
    } else {
      delete process.env.XDG_DATA_HOME
    }
    try { rmSync(testDir, { recursive: true, force: true }) } catch {}
  })

  // ... tests per specification table above
})
```

### Step 2: Add affinity header tests to `test/kiro-acp-model.test.ts`

Add a new `describe("doStream affinity header", ...)` block following existing test patterns in the file.

### Step 3: Add agent config tests to `test/acp-client.test.ts`

Add a new `describe("generateAgentConfig consumer-agnostic", ...)` block.

### Step 4: Run all tests and verify

```bash
bun test
```

## Acceptance Criteria
- [ ] `test/session-storage.test.ts` created with all 11 tests from specification
- [ ] `test/kiro-acp-model.test.ts` has 3 new affinity header tests
- [ ] `test/acp-client.test.ts` has 5 new agent config tests
- [ ] All tests follow AAA pattern (Arrange-Act-Assert)
- [ ] Tests are isolated (no shared state between tests)
- [ ] All tests pass when run: `bun test`
- [ ] Validation commands pass

## Validation Commands

```bash
# Run all tests
cd /Users/nflizaur/Documents/5-coding/open-source/kiro-acp-ai-provider && bun test

# Run only session storage tests
cd /Users/nflizaur/Documents/5-coding/open-source/kiro-acp-ai-provider && bun test test/session-storage.test.ts

# Run only model tests (includes new affinity tests)
cd /Users/nflizaur/Documents/5-coding/open-source/kiro-acp-ai-provider && bun test test/kiro-acp-model.test.ts

# Type check
cd /Users/nflizaur/Documents/5-coding/open-source/kiro-acp-ai-provider && npx tsc --noEmit

# Build
cd /Users/nflizaur/Documents/5-coding/open-source/kiro-acp-ai-provider && npm run build
```

## Notes
- Tests should be deterministic (no flaky tests)
- Use temp directories for file system tests — never write to real XDG paths
- Clean up temp directories in `afterEach`
- Each test should test ONE behavior
- Derive test cases from acceptance criteria in implementation tasks
- The `getSessionFilePath` function should be exported for testability (verify in task 01)
- For affinity header tests, the existing mock patterns in `test/kiro-acp-model.test.ts` should be followed
