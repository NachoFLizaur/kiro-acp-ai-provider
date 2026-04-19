# Credits Display: "X credits" instead of "$X.XX"

## Status: Deferred — Proposed as upstream PR to opencode

## Problem

When kiro is the provider, cost is reported as credits (not USD). The kiro-acp-ai-provider correctly emits credits via `providerMetadata.kiro.credits`, and opencode stores them in the `cost` field. But all 8 display locations format cost as USD (`$X.XX`), which is incorrect for kiro.

## Current State

- kiro credits flow correctly: kiro-cli → `_kiro.dev/metadata` → `providerMetadata.kiro.credits` → `assistantMessage.cost`
- The `cost` field is a bare `number` with no unit metadata
- Every display location uses `Intl.NumberFormat` hardcoded to USD
- `providerID` is available at every display site (TUI, web app, share page, ACP agent)

## Display Locations (8 total)

| # | Location | File | Package |
|---|----------|------|---------|
| 1 | Prompt footer | `packages/opencode/src/cli/cmd/tui/component/prompt/index.tsx` | opencode |
| 2 | Subagent footer | `packages/opencode/src/cli/cmd/tui/routes/session/subagent-footer.tsx` | opencode |
| 3 | Sidebar | `packages/opencode/src/cli/cmd/tui/feature-plugins/sidebar/context.tsx` | opencode |
| 4 | Context usage | `packages/app/src/components/session-context-usage.tsx` | app |
| 5 | Context tab | `packages/app/src/components/session/session-context-tab.tsx` | app |
| 6 | CLI stats | `packages/opencode/src/cli/cmd/stats.ts` | opencode |
| 7 | Share page | `packages/web/src/components/share/common.tsx` + `Share.tsx` | web |
| 8 | ACP agent | `packages/opencode/src/acp/agent.ts` | opencode |

## Recommended Approach: Shared `formatCost()` Utility (Approach C)

Create a shared utility per package boundary. All display locations replace inline `money.format(cost)` with `formatCost(cost, providerID, locale)`.

```typescript
const CREDIT_PROVIDERS = new Set(["kiro"])

export function formatCost(cost: number, providerID: string | undefined, locale: string) {
  if (providerID && CREDIT_PROVIDERS.has(providerID))
    return `${new Intl.NumberFormat(locale, { maximumFractionDigits: 2 }).format(cost)} credits`
  return new Intl.NumberFormat(locale, { style: "currency", currency: "USD" }).format(cost)
}
```

### Files to change: 12 (2 new + 10 modified)

**New utilities:**
- `packages/app/src/utils/format-cost.ts`
- `packages/opencode/src/cli/cmd/tui/util/format-cost.ts` (or inline)

**Modified display sites:** All 8 locations above + `session-context-metrics.ts` + `share/common.tsx`

### Why this approach
- Zero backend/schema changes
- Zero migration
- Zero SDK regeneration
- `providerID` already available at every display site
- Centralizes cost formatting (currently duplicated 6+ times)

## Rejected Approaches

**Approach A (inline checks):** Same logic duplicated 8+ times. Fragile.

**Approach B (add `costUnit` schema field):** Over-engineered. ~18 files, schema migration, SDK regen — all for a display concern. Only one provider uses credits.

## Notes

- Mixed-provider sessions (some messages kiro, some not) are an edge case. Pragmatic solution: check the last assistant message's `providerID`.
- The old `feat/kiro-provider` branch changed 7+ frontend files for credits display — it was more invasive because it added global sync state, types, bootstrap changes, and i18n strings. Approach C is simpler.
- The ACP agent at `agent.ts:122` hardcodes `currency: "USD"` — should be updated to check `providerID` and use `"credits"` for kiro.
