# Implementation Plan — Guided PR Review Redesign

Replace the current iframe-based review companion with a **native, structured "Guided
PR Review"** surface: an ordered walkthrough of a change (core parts in execution order,
low-signal changes grouped later), where each section pairs a high-level explanation
(enriched from the review **ledger** when present) with the **relevant diffs rendered
inline**. Reviewers can comment on diff lines and either fire the comment to an agent or
queue it as a review that syncs to GitHub. A worktree-rooted chat session answers
questions about the PR.

This plan is the single source of truth for the redesign. It folds in every decision
reached during design review and the feasibility findings from the four implementation
spikes (see **Implementation concerns** below).

---

## Resolved design decisions

| # | Decision | Choice |
|---|----------|--------|
| 1 | Contexts served | **One UI for both** working-tree review and GitHub PR review. GitHub affordances (Activity, Submit, "Add to review") hidden when `pr == null`. |
| 2 | Ledger usage | **Optional enrichment.** Present → leads explanations with `intent`/`why`/etc. Absent (external PRs) → ledger omitted from the agent entirely; agent infers from diff. |
| 3 | Section unit | A **concern**, not a file. May span multiple files; the same file may appear in multiple sections. |
| 4 | Section granularity | **File-level for v1** (whole-file diffs, ~free). Hunk-level deferred (needs server-side patch slicing). See concern #1. |
| 5 | Ordering | `core` sections sorted by **execution / data-flow order**; then `supporting`; then a collapsed **low-signal** group. Significance + order are **agent-judged**. |
| 6 | Section progress UI | **Collapse**, not "reviewed" checkboxes. Collapse state is ephemeral; low-signal collapsed by default. |
| 7 | Layout | **Review in the secondary pane, maximized (full-screen) by default.** A **Chat** button un-maximizes to "pop out" the primary chat at ~30%. |
| 8 | Tabs | **Activity · Guide · Diff** (content tabs). **Chat** is a separate layout toggle, not a content tab. |
| 9 | Guide generation | **Same as today** — lazy, cached by branch key, manual regenerate. No staleness banner. |
| 10 | Comments | **Diff-line comments only** (no prose/explanation comments). |
| 11 | Comment destination | **Per-comment toggle.** → Agent (immediate) or → Review (queued draft). Default → Review when a PR exists. |
| 12 | Send to agent | **New tab + new session per comment**, rooted in the PR worktree, seeded with the existing message shape, fired immediately. **No auto-open**; **notification** on kickoff. |
| 13 | Review draft store | **Single shared store**, persisted to `.solus/review-state/<key>.json`. Guide diffs and the Diff tab are both views over it. |
| 14 | Submit review | **Modal**: event (Comment / Approve / Request changes) + summary body + read-only queued-comment list → one `prSubmitReview` (`commitId = pr.headSha`). |
| 15 | "Mark as ready" | **Dropped.** |
| 16 | Activity tab | **Lean** — existing GitHub review threads with reply / resolve / unresolve. Pending drafts stay in the submit tray, not here. |
| 17 | Old companion | **Deleted** — iframe pipeline, `.rc` CSS, focus-hunk bridge, HTML-emitting agent path all removed. |

---

## Layout & information architecture

The slot assignment is deliberate: **chat lives in the primary pane** so it reuses the
existing shared composer dock (which always targets `activeTabId`) with **zero plumbing**.
The review lives in the **secondary pane**, which already supports `maximized`
(`fixed inset:0`).

```
DEFAULT (review maximized)            CHAT POPPED OUT (maximized = false)
┌───────────────────────────┐        ┌────────┬──────────────────────┐
│  REVIEW  (secondary, max)  │        │ CHAT   │  REVIEW (secondary)   │
│  ┌ Activity · Guide · Diff ┐│        │(primary│  Activity·Guide·Diff  │
│  │                         ││  ───►  │ ~30%)  │  ~70%                 │
│  │  explanation ║ diff      ││        │        │                       │
│  └─────────────────────────┘│        │ [dock] │                       │
└───────────────────────────┘        └────────┴──────────────────────┘
        (primary hidden behind overlay)   composer = normal primary dock
```

- **Default:** review fills the screen (secondary `maximized`). Composer dock is behind
  the overlay; we also explicitly suppress it via the existing `inputDockHidden`
  mechanism (precedent: `WorkspaceBody.svelte:99` already suppresses the dock for the
  current companion).
- **Click "Chat":** `maximized = false` → primary chat pops out at `secondaryRatio ≈ 0.7`
  (review keeps ~70%). The chat is the normal primary conversation tab; its composer is
  the normal dock — no special wiring.
- **Pool simplification:** the chat is just the primary conversation, so we **remove** the
  current special-case that excludes the PR chat tab from the conversation pool
  (`WorkspaceBody.svelte:702`) and hand-mounts it inside `PrReviewPane`.

---

## Core model (`src/shared/review-guide.ts`, new)

```ts
export interface ReviewGuide {
  version: 1
  key: string                       // branch key, matches ledger/companion keying
  headSha: string                   // PR head the guide was generated against
  title: string
  summary: string
  sections: GuideSection[]
}

export interface GuideSection {
  id: string
  title: string                     // "Receipt Localization"
  order: number                     // reading order within the `core` band
  significance: 'core' | 'supporting' | 'low-signal'
  explanation: string               // the "why", woven from the ledger when present
  ledgerRefs: string[]              // LedgerRecord.id[] feeding this section (validated)
  files: GuideFileRef[]
}

// v1: whole-file. `ranges` reserved for the deferred hunk-level mode (concern #1).
export interface GuideFileRef {
  path: string
  additions: number
  deletions: number
  // ranges?: { side: 'old' | 'new'; startLine: number; endLine: number }[]   // v2
}
```

The shared review-draft store (persisted) keyed by `(path, line, side)`:

```ts
// .solus/review-state/<key>.json
export interface ReviewState {
  version: 1
  key: string
  drafts: ReviewDraftComment[]      // queued GitHub-bound comments
}

export interface ReviewDraftComment {
  id: string
  path: string
  startLine?: number
  line: number                      // anchor (last line)
  side: 'old' | 'new'               // → LEFT / RIGHT at submit time
  body: string
  createdAt: number
}
```

---

## Implementation concerns — feasibility findings

Four spikes were run against the real code. Verdicts: three green, one with a cost
that reshapes a decision.

### Concern 1 — Hunk-level section diffs ⚠️ feasible, not free

The renderer is **hunk-agnostic** already: Pierre's `FileDiff` renders whatever hunks are
in the parsed metadata; `DiffStream` doesn't filter them. **But** the patch is produced as
a **whole-file unified diff** server-side (`getDiff()` in `src/main/git/session-snapshots.ts`
returns `{ patch: string }`). A partial patch can't be reliably reconstructed from
already-parsed metadata — slicing must happen on the **raw patch string upstream**.

- **File-level (v1): ~free** — render whole-file `Diff.svelte` per file, reuse as-is.
- **Hunk-level (v2): ~4–8h** — server-side patch slicing (parse `@@` headers, rebuild a
  valid unified diff with only selected hunks) + thread hunk-selection through the diff
  request types. Renderer needs **no** change once hunks arrive pre-filtered.

**Decision:** ship **file-level for v1**. Accept that a file appearing in two sections
renders its whole diff twice; dedupe comments by `(path, line, side)` via the shared store.

### Concern 2 — Structured guide output ✅ structured tool on both backends

Correction to an earlier assumption: the **Claude Agent SDK does not expose
`tool_choice`/forced tool use** — only an `allowedTools` whitelist. Reliable pattern, used
today by `record_change`:

- **Claude:** register a `submit_review_guide` in-process MCP tool (zod schema, dual-shape,
  mirrors `src/main/review/ledger-tool.ts`) and **instruct** the agent to call it; validate
  with `zod.safeParse`. Reliably called, not hard-forced.
- **Codex one-shot:** register the tool via `dynamicTools` and capture the call. The
  one-shot's `thread/start` omits `dynamicTools` and its `onServerRequest` denies all tool
  calls today, but both are trivially extendable. With the tool registered, the agent calls
  `submit_review_guide` and **its args ARE the guide** — captured directly, no text-scrape.

**Adding tool registration to the Codex one-shot (`codex-oneshot.ts`):**
1. Pass `dynamicTools: [REVIEW_GUIDE_TOOL_JSON_SCHEMA]` on `thread/start` (currently omitted).
2. In `onServerRequest`, branch on `item/tool/call` + tool name → capture args, `respond({ success: true, ... })`; deny everything else as before.

This is the **same mechanism the interactive backend already uses** (`codex-backend.ts:267`
registers tools; `:710` handles `item/tool/call`), which runs reliably in practice — no
JSON-block parse fallback needed. Effort ~2–4h.

Both backends are a **reliability upgrade** over the current `extractHtml()` text-scrape.
A coverage + dedupe + `ledgerRefs`-exist validation pass runs on the captured guide.

### Concern 3 — Chat composer ✅ eliminated by the layout flip

Originally a ~2–3h "decouple `targetTabId` and thread it to a secondary composer" task.
The **secondary-maximized layout removes it**: chat lives in the **primary** pane, so the
existing shared dock (which targets `activeTabId`) composes for it with **no changes**.
`ConversationView` has no composer of its own; the single dock in `WorkspaceBody` is reused
as-is. **Struck from scope.**

### Concern 4 — Spawn seeded session + notify ✅ ~30min, existing APIs

`submitDiffFeedbackToNewSession` (`src/renderer/.../session-diff-feedback.ts`) already does
the comment→new-session flow: `createTab(worktreePath)` inherits the worktree git context,
seeds the message with code context, and `sendMessage()` fires immediately. Notifications:
`toasts.success(...)` (`toast.store.svelte.ts`) plus the existing hidden-window audio cue.
"New tab + new session per comment, immediate, notification on kickoff" maps ~1:1 onto
existing APIs.

| Concern | Verdict | Effort |
|---------|---------|--------|
| 1 — Hunk-level diffs | ⚠️ file-level free / hunk-level deferred | v1 ~0 / v2 ~4–8h |
| 2 — Structured output | ✅ structured tool, both backends | mirror `record_change` (+~2–4h Codex) |
| 3 — Chat composer | ✅ eliminated by layout flip | 0 |
| 4 — Spawn session + notify | ✅ existing APIs | ~30min |

---

## Deferred to implementation time

1. **File-level vs hunk-level** granularity (concern #1) — start file-level; revisit only if
   duplicate whole-file renders prove annoying.
2. _(Decided)_ Codex one-shot gets the `submit_review_guide` tool via `dynamicTools` — same
   structured path as Claude, no JSON-block fallback (concern #2).
3. Whether "Chat" popped-out **leaves the split** when clicking Guide/Diff/Activity, or
   **re-maximizes**.

---

## Phased milestones

Each milestone is independently shippable. M1 unblocks everything; M2 is the visible payoff.

### M1 — Structured guide model + agent contract
- New `src/shared/review-guide.ts` (model above).
- New `src/main/review/review-guide-tool.ts` — `submit_review_guide` dual-shape tool
  (mirror `ledger-tool.ts`).
- `src/main/review/review-agent.ts` — rewrite prompt to emit the structured guide via the
  tool (Claude) / JSON block (Codex); replace `extractHtml()` with parse + zod-validate +
  coverage/`ledgerRefs` validation.
- `src/main/review/companion.ts` — persist `.solus/review/<key>.json`; drop CSS injection +
  focus-hunk bridge.
- `review-handlers.ts` + `src/preload/index.ts` — `generateCompanion`/`readCompanion` return
  `ReviewGuide`.

### M2 — Native Guide renderer
- `src/renderer/components/pr-review/guide/GuideView.svelte` — ordered sections + collapsed
  low-signal group.
- `GuideSection.svelte` — explanation (left) ║ embedded `Diff.svelte` (right); responsive
  single-column reflow when the pane is narrow (chat popped out).
- `GuideExplanation.svelte` — renders explanation + ledger detail (`why`/`assumptions`/
  `alternatives`/`edgeCases`) collapsible; `question` as a flagged callout.
- Lazy-mount off-screen sections (shared `getDiffWorkerPool()` confirmed — no per-instance
  pools).

### M3 — Pane/IA wiring
- New secondary `PaneContent` kind for the review surface; `enterPrReview` puts review in
  **secondary, maximized**, chat as the **primary** conversation.
- Activity / Guide / Diff tab switcher; **Chat** button = maximize toggle.
- Remove PR-chat pool exclusion + `PrReviewPane` hand-mount; suppress dock when maximized.

### M4 — Comments + shared store
- Reuse `DiffCommentForm` / `DiffInlineComment` inside guide sections and the Diff tab.
- Per-comment **destination toggle** (Agent / Review).
- Single shared draft store → `.solus/review-state/<key>.json` (read/write handlers mirror
  `writeLedger`); both surfaces bind to it; dedupe by `(path, line, side)`.
- Agent path: spawn worktree-rooted session per comment + toast (concern #4).

### M5 — Submit + Activity (GitHub)
- `PendingReviewTray` + `SubmitReviewModal` → `prSubmitReview` (`DraftReview`).
- `ActivityFeed.svelte` — `listReviewThreads` with reply / resolve / unresolve; click → jump
  to line. Gated on `pr != null`.

### M6 — Cleanup
- Delete `ReviewCompanion.svelte`, `.rc` design system, focus-hunk bridge, HTML half of
  `review-agent.ts` / `companion.ts`. Repoint `enterReview` / `GitSection`.

---

## Files: create / modify / delete

**Create**
- `src/shared/review-guide.ts`, `src/shared/review-state.ts`
- `src/main/review/review-guide-tool.ts`, `src/main/review/review-state.ts`
- `src/renderer/components/pr-review/guide/{GuideView,GuideSection,GuideExplanation}.svelte`
- `src/renderer/components/pr-review/{PendingReviewTray,SubmitReviewModal,ActivityFeed}.svelte`

**Modify**
- `src/main/review/{review-agent,companion}.ts`, `review-handlers.ts`, `src/preload/index.ts`
- `src/renderer/contexts/pane-view.store.svelte.ts` (review-in-secondary, maximized default)
- `src/renderer/components/layout/WorkspaceBody.svelte` (pool exclusion removal, dock suppression)
- `src/renderer/components/pr-review/PrReviewPane.svelte` (tabs + chat toggle)
- `src/renderer/components/diff/DiffCommentForm.svelte` (destination toggle)
- `src/main/providers/github/provider.ts` (only if a thread-jump needs more data)

**Delete**
- `src/renderer/components/review/ReviewCompanion.svelte`
- `.rc` CSS design system + focus-hunk bridge + `extractHtml()` HTML path

---

## Risks

- **Guide validation.** Both backends return the guide as structured tool args, but the
  agent can still emit a semantically incomplete guide. A strict zod + coverage +
  `ledgerRefs` validator runs on the captured object; on validation failure, regenerate or
  surface a minimal fallback guide.
- **`ledgerRefs` hallucination.** Agent may emit unknown ids → silently drops enrichment.
  Validate refs against the known ledger; log/skip unknowns.
- **Coverage.** A changed file/hunk omitted from all sections reads as "fully covered."
  Validator must assert every changed file ∈ ≥1 section.
- **Many embedded diffs.** Long guides mount many `Diff.svelte` instances. Worker pool is
  shared (mitigated), but still lazy-mount off-screen sections.
- **Stale guide vs PR head.** Generation keyed by branch, not head SHA (per decision #9).
  `headSha` is stamped in the model for future drift detection, but no banner in v1.
