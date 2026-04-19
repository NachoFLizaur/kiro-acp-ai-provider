# 01. Create XDG Session Storage Module

## Meta
- **ID**: session-storage-01
- **Feature**: session-storage
- **Priority**: P1
- **Depends On**: []
- **Effort**: M (2h)
- **Requires UX/DX Review**: false

## Objective
Extract session persistence into a dedicated `src/session-storage.ts` module using XDG-compliant paths and affinity-based file keying.

## Context
Currently, session persistence is embedded in `KiroACPLanguageModel` as private methods (`persistSessionId`, `tryLoadPersistedSession`, `getSessionFilePath`) that write to `{tmpdir}/kiro-acp/session-{cwdHash}.json`. This task extracts that logic into a standalone module that:
1. Uses `$XDG_DATA_HOME || $HOME/.local/share` as the base path
2. Stores sessions under `kiro-acp-ai-provider/sessions/{cwdHash}/{affinityId}.json`
3. Falls back to `_default.json` when no affinity ID is provided
4. Persists minimal data: `{ kiroSessionId: string, lastUsed: number }`

**User Requirements (immutable)**:
- XDG data directory `~/.local/share/kiro-acp-ai-provider/`
- Path structure `sessions/{cwdHash}/{affinityId}.json`
- Fallback to `_default.json` when no affinity ID
- Minimal mapping `{ kiroSessionId, lastUsed }` per file
- No new dependencies for XDG path resolution
- 24h TTL as staleness check

## Implementation Steps

### Step 1: Create `src/session-storage.ts`

Create the new module with the following exports:

```typescript
import { writeFileSync, readFileSync, mkdirSync } from "node:fs"
import { createHash } from "node:crypto"
import { join } from "node:path"
import { homedir } from "node:os"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Persisted session data — minimal mapping per affinity slot. */
export interface PersistedSession {
  kiroSessionId: string
  lastUsed: number
}

// ---------------------------------------------------------------------------
// XDG base path resolution (~3 lines, no dependencies)
// ---------------------------------------------------------------------------

/**
 * Resolve the XDG data home directory.
 *
 * Uses `$XDG_DATA_HOME` if set, otherwise falls back to `$HOME/.local/share`.
 * This follows the XDG Base Directory Specification without any external deps.
 */
function getXdgDataHome(): string {
  return process.env.XDG_DATA_HOME || join(homedir(), ".local", "share")
}

// ---------------------------------------------------------------------------
// Session file path
// ---------------------------------------------------------------------------

/** Application data directory under XDG data home. */
const APP_DIR = "kiro-acp-ai-provider"

/** Staleness TTL — sessions older than this are not loaded (24 hours). */
const SESSION_TTL_MS = 24 * 60 * 60 * 1000

/**
 * Get the directory for session files for a given working directory.
 *
 * Path: `{xdgDataHome}/kiro-acp-ai-provider/sessions/{cwdHash}/`
 */
function getSessionDir(cwd: string): string {
  const cwdHash = createHash("md5").update(cwd).digest("hex").slice(0, 8)
  return join(getXdgDataHome(), APP_DIR, "sessions", cwdHash)
}

/**
 * Get the full path to a session file.
 *
 * @param cwd - Working directory (hashed for the directory component)
 * @param affinityId - Session affinity identifier, or undefined for the default slot
 * @returns Path like `~/.local/share/kiro-acp-ai-provider/sessions/{cwdHash}/{affinityId}.json`
 */
export function getSessionFilePath(cwd: string, affinityId?: string): string {
  const fileName = affinityId ? `${affinityId}.json` : "_default.json"
  return join(getSessionDir(cwd), fileName)
}

// ---------------------------------------------------------------------------
// Persist / Load
// ---------------------------------------------------------------------------

/**
 * Persist a session ID to disk (best-effort, failures silently ignored).
 *
 * Writes minimal data: `{ kiroSessionId, lastUsed }`.
 * Creates the directory tree if it doesn't exist.
 */
export function persistSession(cwd: string, sessionId: string, affinityId?: string): void {
  try {
    const filePath = getSessionFilePath(cwd, affinityId)
    const dir = join(filePath, "..")
    mkdirSync(dir, { recursive: true })
    const data: PersistedSession = {
      kiroSessionId: sessionId,
      lastUsed: Date.now(),
    }
    writeFileSync(filePath, JSON.stringify(data))
  } catch {
    // Best-effort — ignore write failures
  }
}

/**
 * Try to load a previously persisted session from disk.
 *
 * Returns the persisted data if:
 * - The file exists and is valid JSON
 * - The session is not older than 24 hours (TTL check)
 *
 * Returns null otherwise (silently — caller creates a new session).
 */
export function loadPersistedSession(cwd: string, affinityId?: string): PersistedSession | null {
  try {
    const filePath = getSessionFilePath(cwd, affinityId)
    const raw = readFileSync(filePath, "utf-8")
    const data = JSON.parse(raw) as PersistedSession

    // Staleness check — don't load sessions older than 24h
    if (Date.now() - data.lastUsed > SESSION_TTL_MS) return null

    // Validate shape
    if (!data.kiroSessionId || typeof data.kiroSessionId !== "string") return null

    return data
  } catch {
    return null
  }
}
```

### Step 2: Refactor `src/kiro-acp-model.ts` to use the new module

Replace the inline persistence methods with calls to the new module:

1. **Remove** the following private methods from `KiroACPLanguageModel`:
   - `getSessionFilePath()` (lines 471-474)
   - `persistSessionId()` (lines 482-495)
   - `tryLoadPersistedSession()` (lines 507-525)

2. **Remove** the `tmpdir` import from `node:os` (line 17) — no longer needed.

3. **Add** import for the new module:
   ```typescript
   import { persistSession, loadPersistedSession } from "./session-storage"
   ```

4. **Add** a private field to track the current affinity ID:
   ```typescript
   private currentAffinityId: string | undefined
   ```

5. **Replace** all calls to `this.persistSessionId(sessionId)` with:
   ```typescript
   persistSession(this.client.getCwd(), sessionId, this.currentAffinityId)
   ```

6. **Replace** the persisted session loading block in `acquireSession()` with:
   ```typescript
   const persisted = loadPersistedSession(this.client.getCwd(), this.currentAffinityId)
   if (persisted) {
     try {
       const session = await this.client.loadSession(persisted.kiroSessionId)
       if (session?.sessionId) {
         await this.ensureSessionMode(session)
         this.sessions.push(session)
         this.busySessions.add(session.sessionId)
         if (this.currentModelId === null) {
           this.currentModelId = session.models?.currentModelId ?? null
         }
         persistSession(this.client.getCwd(), session.sessionId, this.currentAffinityId)
         return session
       }
     } catch {
       // Fall through to create new session
     }
   }
   ```

7. **Update** `releaseSession()` to use the new persist call:
   ```typescript
   private releaseSession(sessionId: string): void {
     this.busySessions.delete(sessionId)
     if (this.sessions[0]?.sessionId === sessionId) {
       persistSession(this.client.getCwd(), sessionId, this.currentAffinityId)
     }
   }
   ```

8. **Add** a public method to set the affinity ID (called from doStream):
   ```typescript
   /** Set the session affinity ID for routing to the correct persisted session file. */
   setAffinityId(affinityId: string | undefined): void {
     this.currentAffinityId = affinityId
   }
   ```

### Step 3: Update the session persistence JSDoc comments

Update the section header comment (around line 462) from:
```
// Session persistence (across process restarts)
```
to reflect that persistence is now delegated to the session-storage module.

Remove the old JSDoc comments for the deleted methods.

## Files to Change

| File | Action | Changes |
|------|--------|---------|
| `src/session-storage.ts` | Create | New XDG session storage module |
| `src/kiro-acp-model.ts` | Modify | Remove inline persistence, import new module, add affinityId field |

## Tests

### Unit Tests
- **File**: `test/session-storage.test.ts` (created in task 05)
- **Test**: XDG path resolution, persist/load cycle, TTL expiry, affinity keying, _default fallback
- **Pattern**: Arrange-Act-Assert
- **Coverage**: `getSessionFilePath`, `persistSession`, `loadPersistedSession`

## Acceptance Criteria
- [ ] `src/session-storage.ts` exists with `getSessionFilePath`, `persistSession`, `loadPersistedSession` exports
- [ ] `PersistedSession` type contains only `{ kiroSessionId: string, lastUsed: number }` — no `modelId`
- [ ] XDG path resolves to `$XDG_DATA_HOME/kiro-acp-ai-provider/sessions/{cwdHash}/` or `~/.local/share/kiro-acp-ai-provider/sessions/{cwdHash}/`
- [ ] Default file is `_default.json` when no affinity ID provided
- [ ] 24h TTL check returns null for stale sessions
- [ ] `kiro-acp-model.ts` no longer imports `tmpdir` from `node:os`
- [ ] `kiro-acp-model.ts` no longer contains `getSessionFilePath`, `persistSessionId`, or `tryLoadPersistedSession` methods
- [ ] `kiro-acp-model.ts` imports and uses `persistSession` and `loadPersistedSession` from `./session-storage`
- [ ] No new npm dependencies added
- [ ] All validation commands pass

## Validation Commands

```bash
# Type check
cd /Users/nflizaur/Documents/5-coding/open-source/kiro-acp-ai-provider && npx tsc --noEmit

# Build
cd /Users/nflizaur/Documents/5-coding/open-source/kiro-acp-ai-provider && npm run build

# Run existing tests (should still pass — no test changes yet)
cd /Users/nflizaur/Documents/5-coding/open-source/kiro-acp-ai-provider && bun test
```

## Notes
- The `createHash("md5")` cwdHash logic is preserved from the existing implementation (first 8 hex chars)
- `mkdirSync` with `recursive: true` handles the full directory tree creation
- The `dirname()` import can be used instead of `join(filePath, "..")` — implementer's choice
- The `homedir()` import replaces the need for `tmpdir()` — both from `node:os`
- Keep the best-effort write pattern (try/catch with empty catch) — this is intentional
