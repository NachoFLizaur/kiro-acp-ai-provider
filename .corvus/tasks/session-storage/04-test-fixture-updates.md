# 04. Update Test Fixtures for Source Changes

## Meta
- **ID**: session-storage-04
- **Feature**: session-storage
- **Priority**: P1
- **Depends On**: [session-storage-01, session-storage-03]
- **Effort**: S (1h)
- **Requires UX/DX Review**: false

## Objective
Update all test fixtures that reference opencode-specific values or old session storage paths to match the source changes from tasks 01 and 03.

## Context
Tasks 01 and 03 changed functional code: the MCP server name is now dynamic (`${name}-tools`), the default agent name is `"kiro-acp"`, and session storage moved to XDG paths. Test fixtures that hardcode the old values will fail. This task updates them.

This is separate from task 05 (which writes NEW tests) — this task only fixes EXISTING tests.

## Implementation Steps

### Step 1: Update `test/kiro-acp-model.test.ts` — Mock agent name

**Lines 249, 273, 279, 283** — Mock agent name `"opencode"` → `"test-agent"`:

Find all instances where the mock agent name is set to `"opencode"` and replace with `"test-agent"`. This is a test-only value — it doesn't need to match any real consumer.

Pattern to find:
```typescript
"opencode"
```
Replace with:
```typescript
"test-agent"
```

Only in test fixture/mock contexts — verify each occurrence is a mock value, not a string assertion.

### Step 2: Update `test/acp-client.test.ts` — MCP server name fixtures

**Lines 409, 417, 433, 434** — Test fixtures `"mcp:opencode-tools"` → match dynamic name:

Since the MCP server name is now `${name}-tools`, and the default name is `"kiro-acp"`, update fixtures:

Replace:
```typescript
"mcp:opencode-tools"
```
With:
```typescript
"mcp:kiro-acp-tools"
```

Or if the test provides a custom agent name (e.g. `"test-agent"`), use:
```typescript
"mcp:test-agent-tools"
```

Check each occurrence to determine which name the test is using.

### Step 3: Update any session path assertions

If any existing tests assert on the old session file path (`{tmpdir}/kiro-acp/session-{cwdHash}.json`), update them to use the new XDG path pattern. Check `test/kiro-acp-model.test.ts` for any such assertions.

### Step 4: Verify all existing tests pass

Run the full test suite and ensure all 142+ existing tests pass with the updated fixtures.

## Files to Change

| File | Action | Changes |
|------|--------|---------|
| `test/kiro-acp-model.test.ts` | Modify | Replace mock agent name "opencode" → "test-agent" |
| `test/acp-client.test.ts` | Modify | Replace "mcp:opencode-tools" → "mcp:kiro-acp-tools" or "mcp:test-agent-tools" |

## Tests

### Verification
- All 142+ existing tests must pass after fixture updates
- No new tests are added in this task (that's task 05)

## Acceptance Criteria
- [ ] `rg -i "opencode" --type ts test/` returns zero results
- [ ] All existing tests pass: `bun test` exits with 0
- [ ] Mock agent names use `"test-agent"` (not `"opencode"`)
- [ ] MCP server name fixtures match the dynamic naming pattern
- [ ] No test logic changes — only fixture/mock value updates
- [ ] All validation commands pass

## Validation Commands

```bash
# Type check
cd /Users/nflizaur/Documents/5-coding/open-source/kiro-acp-ai-provider && npx tsc --noEmit

# Run ALL existing tests — must pass
cd /Users/nflizaur/Documents/5-coding/open-source/kiro-acp-ai-provider && bun test

# Verify no opencode references in tests
cd /Users/nflizaur/Documents/5-coding/open-source/kiro-acp-ai-provider && ! rg -i "opencode" --type ts test/

# Build
cd /Users/nflizaur/Documents/5-coding/open-source/kiro-acp-ai-provider && npm run build
```

## Notes
- This task is intentionally narrow: only update existing test fixtures, don't add new tests
- The separation ensures task 03 (source changes) and task 04 (test fixtures) can be verified independently
- After this task, `rg -i "opencode" --type ts` across the entire project should return zero results
- If any test uses the agent name for functional assertions (not just mock setup), verify the assertion still makes sense with the new default
