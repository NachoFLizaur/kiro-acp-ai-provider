# 02. Wire x-session-affinity Header Through doStream()

## Meta
- **ID**: session-storage-02
- **Feature**: session-storage
- **Priority**: P1
- **Depends On**: [session-storage-01]
- **Effort**: S (1h)
- **Requires UX/DX Review**: false

## Objective
Extract the `x-session-affinity` header from `options.headers` in `doStream()` and use it to route session persistence to the correct affinity-keyed file.

## Context
Consumers like opencode already send `x-session-affinity: <sessionID>` in `options.headers` when calling `doStream()`. Currently, `doStream()` ignores all headers. This task reads the affinity header and passes it to the session storage module (created in task 01) so that different consumer sessions get their own persisted session files.

The affinity mechanism is optional — when no header is present, the provider falls back to `_default.json` (the default slot).

**User Requirements (immutable)**:
- Read `x-session-affinity` from `options.headers` in `doStream()`
- Affinity mechanism is optional — works with or without header
- Fallback to `_default.json` when no affinity ID
- Provider must remain consumer-agnostic

## Implementation Steps

### Step 1: Extract affinity header in `doStream()`

At the top of the `doStream()` method in `src/kiro-acp-model.ts`, extract the affinity header:

```typescript
async doStream(
  options: LanguageModelV3CallOptions,
): Promise<LanguageModelV3StreamResult> {
  // Extract session affinity from consumer-provided headers (optional).
  // When present, routes to a dedicated persisted session file per affinity ID.
  // When absent, falls back to _default.json.
  const affinityId = typeof options.headers?.["x-session-affinity"] === "string"
    ? options.headers["x-session-affinity"]
    : undefined
  this.setAffinityId(affinityId)

  // ... rest of existing doStream logic
```

This must happen BEFORE the `acquireSession()` call so the affinity ID is available when loading/persisting sessions.

### Step 2: Verify header type safety

The `LanguageModelV3CallOptions` type from `@ai-sdk/provider` includes `headers?: Record<string, string | undefined>`. The `x-session-affinity` value is a string when present. The `typeof === "string"` check handles both missing headers object and undefined values.

### Step 3: Verify the flow

The complete flow after this change:

1. Consumer calls `doStream()` with `options.headers["x-session-affinity"] = "some-id"`
2. `doStream()` extracts `"some-id"` and calls `this.setAffinityId("some-id")`
3. `acquireSession()` calls `loadPersistedSession(cwd, "some-id")` → reads `{cwdHash}/some-id.json`
4. On session creation/refresh, `persistSession(cwd, sessionId, "some-id")` → writes `{cwdHash}/some-id.json`

Without the header:
1. Consumer calls `doStream()` without the header
2. `doStream()` calls `this.setAffinityId(undefined)`
3. `acquireSession()` calls `loadPersistedSession(cwd, undefined)` → reads `{cwdHash}/_default.json`
4. On session creation/refresh, `persistSession(cwd, sessionId, undefined)` → writes `{cwdHash}/_default.json`

## Files to Change

| File | Action | Changes |
|------|--------|---------|
| `src/kiro-acp-model.ts` | Modify | Add affinity header extraction at top of `doStream()` |

## Tests

### Unit Tests
- **File**: `test/kiro-acp-model.test.ts` (in task 05)
- **Test**: doStream with affinity header routes to correct session file; doStream without header uses _default
- **Pattern**: Arrange-Act-Assert

## Acceptance Criteria
- [ ] `doStream()` reads `x-session-affinity` from `options.headers`
- [ ] Affinity ID is set BEFORE `acquireSession()` is called
- [ ] When header is present, `setAffinityId()` receives the string value
- [ ] When header is absent, `setAffinityId()` receives `undefined`
- [ ] When headers object itself is undefined, no error is thrown
- [ ] Provider remains consumer-agnostic — no reference to specific consumers
- [ ] All validation commands pass

## Validation Commands

```bash
# Type check
cd /Users/nflizaur/Documents/5-coding/open-source/kiro-acp-ai-provider && npx tsc --noEmit

# Build
cd /Users/nflizaur/Documents/5-coding/open-source/kiro-acp-ai-provider && npm run build

# Run existing tests
cd /Users/nflizaur/Documents/5-coding/open-source/kiro-acp-ai-provider && bun test
```

## Notes
- The `LanguageModelV3CallOptions.headers` type is `Record<string, string | undefined> | undefined`
- The `typeof` check is defensive — handles both `undefined` headers object and missing key
- This is a ~5 line change in `doStream()` — intentionally minimal
- The `setAffinityId()` method was added in task 01
