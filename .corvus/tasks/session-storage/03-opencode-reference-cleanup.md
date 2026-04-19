# 03. Remove All Opencode-Specific References

## Meta
- **ID**: session-storage-03
- **Feature**: session-storage
- **Priority**: P1
- **Depends On**: []
- **Effort**: M (1.5h)
- **Requires UX/DX Review**: false

## Objective
Remove all opencode-specific references from source files to make the provider fully consumer-agnostic.

## Context
The provider currently contains 20 references to "opencode" across 5 source files. These range from functional code (hardcoded MCP server names, default agent names) to comments and JSDoc. All must be genericized so the provider works with any consumer, not just opencode.

**User Requirements (immutable)**:
- Provider must remain consumer-agnostic
- Remove opencode-specific references

## Implementation Steps

### Step 1: Fix HIGH SEVERITY — `src/agent-config.ts`

**Line 38 — MCP server name hardcoded as `"opencode-tools"`:**

Replace:
```typescript
const mcpServerName = "opencode-tools"
```
With a dynamic name derived from the agent name:
```typescript
const mcpServerName = `${(options.name ?? "kiro-acp")}-tools`
```

**Line 44 — Default agent name `"opencode"`:**

Replace:
```typescript
name: options.name ?? "opencode",
```
With:
```typescript
name: options.name ?? "kiro-acp",
```

**Lines 62-63 — System prompt says "integrated into the opencode editor":**

Replace:
```typescript
`You are a coding assistant integrated into the opencode editor. Follow the user's instructions precisely and use tools proactively.
```
With:
```typescript
`You are a coding assistant. Follow the user's instructions precisely and use tools proactively.
```

### Step 2: Fix LOW SEVERITY — `src/kiro-acp-model.ts` comments

**Line 74 — Comment referencing opencode-tools:**

Replace:
```typescript
// Extract tool name from title: "Running: @opencode-tools/bash" → "bash"
```
With:
```typescript
// Extract tool name from title: "Running: @<server>/bash" → "bash"
```

**Line 538 — JSDoc referencing opencode:**

Replace:
```typescript
* Used when session/load fails and we need to rehydrate from opencode's history.
```
With:
```typescript
* Used when session/load fails and we need to rehydrate from the consumer's history.
```

### Step 3: Fix LOW SEVERITY — `src/acp-client.ts` comments

**Line 100** — Look for and genericize any opencode reference in comments/JSDoc.
**Line 504** — Same.
**Line 753** — Same.
**Lines 788-789** — Same.

Pattern: Replace "opencode" with "the consumer" or "the host application" as contextually appropriate.

### Step 4: Fix LOW SEVERITY — `src/kiro-acp-provider.ts`

**Line 15-16** — JSDoc comment:

Replace:
```typescript
/** Custom agent name passed via --agent flag (e.g. "opencode"). */
```
With:
```typescript
/** Custom agent name passed via --agent flag (e.g. "my-editor"). */
```

### Step 5: Fix LOW SEVERITY — `src/mcp-bridge-tools.ts`

**Line 30-31** — JSDoc comment:

Replace:
```typescript
* Returns the default set of tool definitions that match what opencode
* typically provides. These are the tools kiro-cli's model can call.
```
With:
```typescript
* Returns the default set of tool definitions for the MCP bridge.
* These are the tools kiro-cli's model can call.
```

### Step 6: Verify no remaining references

After all changes, run:
```bash
rg -i "opencode" --type ts src/
```
This should return zero results.

## Files to Change

| File | Action | Changes |
|------|--------|---------|
| `src/agent-config.ts` | Modify | Dynamic MCP server name, default agent name, system prompt |
| `src/kiro-acp-model.ts` | Modify | Genericize 2 comments |
| `src/acp-client.ts` | Modify | Genericize 4 comments/JSDoc |
| `src/kiro-acp-provider.ts` | Modify | Genericize 1 JSDoc comment |
| `src/mcp-bridge-tools.ts` | Modify | Genericize 1 JSDoc comment |

## Tests

### Unit Tests
- **File**: `test/acp-client.test.ts`, `test/kiro-acp-model.test.ts` (in task 04)
- **Test**: Agent config generates correct MCP server name from agent name
- **Coverage**: `generateAgentConfig` with various name inputs

## Acceptance Criteria
- [ ] `rg -i "opencode" --type ts src/` returns zero results
- [ ] MCP server name is dynamically derived: `${name}-tools` (not hardcoded)
- [ ] Default agent name is `"kiro-acp"` (not `"opencode"`)
- [ ] System prompt does not reference any specific editor
- [ ] All comments/JSDoc are consumer-agnostic
- [ ] `generateAgentConfig({ mcpBridgePath: "...", toolsFilePath: "...", cwd: "..." })` produces `name: "kiro-acp"` and MCP server `"kiro-acp-tools"`
- [ ] `generateAgentConfig({ name: "my-editor", ... })` produces MCP server `"my-editor-tools"`
- [ ] All validation commands pass

## Validation Commands

```bash
# Type check
cd /Users/nflizaur/Documents/5-coding/open-source/kiro-acp-ai-provider && npx tsc --noEmit

# Build
cd /Users/nflizaur/Documents/5-coding/open-source/kiro-acp-ai-provider && npm run build

# Verify no opencode references in source
cd /Users/nflizaur/Documents/5-coding/open-source/kiro-acp-ai-provider && ! rg -i "opencode" --type ts src/

# Run existing tests (some may fail — test fixtures updated in task 04)
cd /Users/nflizaur/Documents/5-coding/open-source/kiro-acp-ai-provider && bun test || true
```

## Notes
- The MCP server name change from `"opencode-tools"` to `"${name}-tools"` is a **functional change** — it affects the `tools` and `allowedTools` arrays and the `mcpServers` key in the agent config
- The `mcpServerRef` variable (`@${mcpServerName}`) is used in `tools` and `allowedTools` — both will automatically pick up the dynamic name
- Test fixtures in `test/acp-client.test.ts` reference `"mcp:opencode-tools"` — these are updated in task 04
- Some existing tests may fail after this task until task 04 updates fixtures — this is expected
