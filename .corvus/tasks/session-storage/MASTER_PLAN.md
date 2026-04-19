# XDG Session Storage + Opencode Reference Cleanup - Master Plan (Lightweight)

**Objective**: Replace tmpdir-based session persistence with XDG-compliant storage keyed by affinity ID, and remove all opencode-specific references to make the provider consumer-agnostic.
**Status**: [ ] Planning | [ ] In Progress | [x] Complete
**Plan Type**: Lightweight
**Created**: 2026-04-16
**Total Tasks**: 5
**Estimated Effort**: 7h
**Test Preference**: `tests_enabled: true, tests_deferred: true` — test tasks generated but deferred to Phase 5

---

## Tasks

| Order | Task ID | File | Description | Type | Status |
|-------|---------|------|-------------|------|--------|
| 1 | session-storage-01 | `01-xdg-session-module.md` | Create XDG session storage module | impl | [x] |
| 2 | session-storage-02 | `02-affinity-header-plumbing.md` | Wire x-session-affinity header through doStream() | impl | [x] |
| 3 | session-storage-03 | `03-opencode-reference-cleanup.md` | Remove all opencode-specific references | impl | [x] |
| 4 | session-storage-04 | `04-test-fixture-updates.md` | Update test fixtures for source changes | impl | [x] |
| 5 | session-storage-05 | `05-phase-tests.md` | Comprehensive tests for session storage + cleanup | **test** | [x] |

**Milestone**: Provider uses XDG-compliant session storage with affinity-based keying, all opencode references removed, all tests passing.

---

## Files Summary

| File | Task | Action | Purpose |
|------|------|--------|---------|
| `src/session-storage.ts` | 01 | Create | XDG session storage module |
| `src/kiro-acp-model.ts` | 01, 02 | Modify | Replace persistence methods, wire affinity header |
| `src/agent-config.ts` | 03 | Modify | Remove opencode defaults, make consumer-agnostic |
| `src/acp-client.ts` | 03 | Modify | Clean up opencode comments/JSDoc |
| `src/kiro-acp-provider.ts` | 03 | Modify | Clean up opencode JSDoc |
| `src/mcp-bridge-tools.ts` | 03 | Modify | Clean up opencode JSDoc |
| `test/kiro-acp-model.test.ts` | 04, 05 | Modify | Update fixtures + add session storage tests |
| `test/acp-client.test.ts` | 04 | Modify | Update opencode test fixtures |
| `test/session-storage.test.ts` | 05 | Create | Unit tests for session storage module |

---

## Quick Reference

```
 1. session-storage-01  XDG session storage module          [x]
 2. session-storage-02  Affinity header plumbing             [x]
 3. session-storage-03  Opencode reference cleanup           [x]
 4. session-storage-04  Test fixture updates                 [x]
 5. session-storage-05  Phase tests (deferred)               [x]
```

**Progress**: 5/5 tasks complete (100%)

---

## Dependencies

```
01 (session module) -> 02 (affinity plumbing, uses new module)
01 -> 04 (test fixtures reference new storage paths)
03 (standalone — no deps)
01, 02, 03, 04 -> 05 (tests for everything)
```

### Parallel Opportunities
- Tasks 01 and 03 can run in parallel (no dependencies between them)

### Critical Path
01 -> 02 -> 05 (longest dependency chain)

---

## Exit Criteria

- [x] All tasks marked complete
- [x] All tests passing (deferred to Phase 5)
- [x] All acceptance criteria verified
- [x] Build succeeds (`npm run build`)
- [x] Session files written to `~/.local/share/kiro-acp-ai-provider/sessions/{cwdHash}/`
- [x] Affinity header routes to correct session file
- [x] Fallback to `_default.json` when no affinity header
- [x] Zero references to "opencode" in source files (excluding git history)
- [x] 24h TTL staleness check preserved

---

## Risk Assessment

| Risk | Impact | Likelihood | Mitigation |
|------|--------|------------|------------|
| Breaking existing session resumption | High | Low | New module is drop-in replacement; same load/persist API surface |
| XDG path not writable on some systems | Med | Low | mkdirSync with recursive: true; best-effort write pattern preserved |
| Test fixtures out of sync with source changes | Med | Med | Task 04 explicitly updates all test fixtures before test task runs |
| Agent config name change breaks consumers | High | Low | Default changes from "opencode" to "kiro-acp" — documented in task |

---

## References

- User requirements: XDG data directory, affinity-based session keying, consumer-agnostic provider
- Existing persistence: `src/kiro-acp-model.ts` lines 462-525
- Affinity header source: opencode `llm.ts:367` sends `x-session-affinity`
