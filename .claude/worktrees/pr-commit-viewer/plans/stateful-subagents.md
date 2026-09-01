# Stateful cross-provider subagents (claude_subagent / codex_subagent)

## Context

The cross-provider subagent tools (`claude_subagent` given to Codex parents, `codex_subagent` given to Claude parents — cross-registered at `control-plane.ts:2168-2177`) are memoryless one-shots: each call runs a real provider session with `persistence: 'ephemeral'`, relays the transcript into the parent's subagent card, returns the final text, and discards the session. The parent can't follow up without restating all context, and no child-session handle exists anywhere.

This change makes them stateful: the parent agent resumes a prior subagent via a new `session_id` tool param, preserving the subagent's full context. The resume plumbing (`AgentRunRequest.sessionId` → Claude SDK `resume` at `claude-agent.ts:167-171` / Codex `thread/resume` at `codex-backend.ts:325-328`) already exists and is unused; the blockers are that ephemeral runs are never materialized on disk (Claude `persistSession:false`; Codex thread `ephemeral:true`) and that no id survives the tool call.

**Decisions (user-confirmed direction: no backwards compatibility required; consolidate with the session substrate where it simplifies; no new persistence value — provider capabilities only):**
- **Card threading:** each resume renders its own card (own tool call/toolUseId) with a "continued" indicator; the subagent pane gets "Turn N of M" prev/next navigation. No merge-into-one-card exchanges model.
- **Who resumes:** model-driven only. A user-facing composer in the pane (reusing `AgentConversationComposer`) is a future extension, out of scope.
- **Reload transcript backfill:** out of scope (separable follow-up). If pursued later on the Codex side, flip `persistExtendedHistory` to `!== 'ephemeral'` so `thread/read` replay is rich. Note: with index-and-flag (below), `read_session` already works on children for the model — the remaining gap is only the pane's Transcript tab.
- **Consolidation stance:** subagent children are indexed as first-class sessions, flagged and filtered out of user-facing listings only (not excluded at ingest). The subagent tool and `create_session` become two front-ends — blocking vs. detached — over the same session substrate. Full unification (subagent tool calling the ControlPlane session-creation path and awaiting settle) is explicitly rejected: incompatible lifecycle (abort-with-parent), permission model (unattended), and event relay (parentToolUseId tagging), and it drags in tab/broadcast machinery.
- **Tool file consolidation:** the two near-duplicate tool files merge into one shared factory (they had already drifted — zod object vs. raw shape validation).

**Verified facts the design rests on:**
- Codex: `ephemeral:false` + `persistExtendedHistory:false` = a stock resumable Codex thread (rollout on disk; `ThreadResumeParams` resumes "by thread_id from disk"). `persistExtendedHistory` is a Solus extras knob (`codex-protocol.ts:66-71`), not a protocol field. `thread/resume` re-sends `baseInstructions`/`developerInstructions` and the `dynamicTools` array (toolsConfig spread, `codex-backend.ts:325-328`), and `turn/start` re-sends sandbox/approval per turn — resumed subagents keep the Solus toolbox and system prompt to the same extent normal resumed sessions do.
- The result-text marker survives reload verbatim on BOTH parent providers (Claude jsonl `tool_result` → `session-transcript.ts:129-140`; Codex `dynamicToolCall` output contentItems → `codex-utils.ts:452-462` → `session-transcript.ts:209-212`). The marker lives in the parent's transcript, which is always `'session'`-persisted.
- Desktop and web share `src/renderer` (client/ aliases into it) — UI changes are made once.

---

## Phase 1 — no new persistence tier (decision: stick with provider capabilities)

The existing two-value `persistence: 'session' | 'ephemeral'` stays untouched. Subagent runs simply switch from `'ephemeral'` to `'session'` (one word in the tool, Phase 3) — persisted because resume requires it; whatever else `'session'` brings, we accept. Utility runs (review-agent, text-generator) stay `'ephemeral'` unchanged.

**No backend or control-plane edits needed** — verified consequences of `'session'` children flowing through `control-plane.ts` `_wireBackend`:
- Tab routing no-ops: dispatcher runs have no `sourceTabId`, so `session_init` binds no tab, and the tab-level section returns early on `_findTabsBySession(childId) → []` — no double-rendering alongside the parent-relayed events.
- `persistIndexedSessionStart` is skipped for children (gated on `activeRunRequests`/`pendingStarts`, which only session starts populate). Indexing happens via the normal fs-watcher/thread-list paths, which Phase 2 filters.
- Children get an `activeSessions` entry (running → completed, cleaned up on exit) — a bonus: `liveStatus` reports real status for `read_session` on a child.
- Accepted session-grade side effects on children: Claude file checkpointing + git-snapshot callbacks (`claude-backend.ts:206-216`), Codex `initSnapshots` (`codex-backend.ts:339`) and session-list cache invalidation. Harmless noise; checkpointing on child edits is arguably useful.
- Known rare race, documented not engineered around: child `session_init` overwrites the Claude permissions *fallback* session id (`control-plane.ts:281` → `claude-permissions.ts:143-152`), which only matters for a permission arriving before a brand-new tab's own init at that exact moment.

## Phase 2 — child-session registry + index-and-flag filtering

Children are **indexed normally as first-class sessions** and filtered out of user-facing surfaces only. This is the consolidation with the session substrate: `getSessionInfo`/`findSession` resolve children, so the existing `read_session` tool works on a subagent child for free (`loadSessionTail` reads provider files by id), and later promotion to `prompt_session`/full sessions is a small follow-up, not an architecture change.

5. Append a migration to `src/main/db/migrations.ts` (raw-SQL string array pattern):
   ```sql
   CREATE TABLE subagent_runs (
     child_session_id TEXT PRIMARY KEY,
     provider TEXT NOT NULL,
     parent_session_id TEXT,
     read_only INTEGER,
     model TEXT,
     created_at INTEGER,
     last_used_at INTEGER
   );
   CREATE INDEX subagent_runs_by_parent ON subagent_runs(parent_session_id);
   ```
6. New `src/main/db/subagent-runs.ts` (prepared-statement style of `session-indexer.ts`):
   - `upsertSubagentRun({childSessionId, provider, parentSessionId, readOnly, model})` — `ON CONFLICT DO UPDATE SET last_used_at`; invalidates cached Set.
   - `getSubagentRun(childSessionId)` — resume validation.
   - `isSubagentChildSession(id)` / module-cached id Set for the listing filters.
7. **No indexer/ingest exclusion.** Do NOT touch the sidechain de-listing branch (`session-indexer.ts:283`) or the Codex candidate filter (`codex-backend.ts:503`) — children index like any session.
8. Filter at the user-facing chokepoints only:
   - `listIndexedSessions` (`session-indexer.ts:562`) and `listIndexedCodexSessions` (:576): `WHERE session_id NOT IN (SELECT child_session_id FROM subagent_runs)` (or a join).
   - The FTS query behind `search_sessions` (`searchIndexedSessions` in session-indexer.ts): same exclusion, so past subagent chatter doesn't surface in the user's search results.
   - Claude cold-scan path (`claude-backend.ts` `scanSessionsInDir` results, ~365) and the Codex `mergeSessionListCache` path (~560-570): filter by the cached id Set before returning/caching, since both bypass the indexed queries.
   - During implementation, verify all session-picker RPCs flow through these points (check `server/handlers/provider-handlers.ts` / `session-handlers.ts`); if any surface hits a backend `listSessions` directly, filter at each backend's return instead.
   (Known limit: children still appear in the Codex CLI's own `codex resume` picker — outside our control.)

## Phase 3 — tool changes (single shared factory)

9. New `src/shared/subagent-marker.ts`: `buildSubagentMarker(id)` → `\n\n[subagent id: <id> — pass session_id to continue this subagent]` and line-anchored `parseSubagentMarker(text): string | null`. Single source of truth for main + renderer.
10. **Merge the two near-duplicate tool files** into one factory, e.g. `src/main/agents/tools/subagent-tool.ts`: `createSubagentAgentTool(config, dispatcher)` where config carries `{name, provider, defaultModel, modelHint, effortValues, systemPromptAgent, sandboxNote}` — the only real deltas between the current files. `claude-subagent-tool.ts` and `codex-subagent-tool.ts` shrink to config definitions (or are deleted with the configs inlined at the registration site, `control-plane.ts:2172-2177`). Unify on the zod-object + `.parse()` style. Behavior for both:
    - Schema: add `session_id?: string` ("Continue a previous subagent from this conversation; pass the subagent id from an earlier call's result. It retains its full prior context."). Update descriptions — replace "it has no memory between calls".
    - Validate resume: `getSubagentRun(session_id)` must exist, provider must match the tool, and `parent_session_id` must equal `context.sessionId()` — else `ok:false` error (never silently start fresh). Guards the model passing a bogus or foreign id (worst case: resuming the user's own session).
    - In-flight guard: module-level map keyed by child sessionId; a second concurrent call with the same `session_id` returns `ok:false, "subagent <id> is still running"`. (Same-id concurrent runs corrupt `activeRuns` keying in `base-backend.ts:10` and collide turns.)
    - Run: `persistence: 'session'`, `sessionId: args.session_id ?? null`. On resume, default omitted `read_only`/`model` from the registry row so a read-only chain can't silently become writable (Claude permissionMode and Codex per-turn sandbox are recomputed per call).
    - Registry: upsert as soon as `run.sessionId` resolves (closes the race where the fs-watcher/Codex poll indexes a mid-run child), and again with `result.sessionId` after `run.done`.
    - Result: append the marker to success text only (skip on SIGINT/error), after the empty-output fallback so every success carries it.

## Phase 4 — renderer (shared desktop + web)

11. `src/renderer/components/conversation/lib/subagent.ts`: add `session_id?: string` to `SubagentInput` (parser is passthrough). New `subagentChain(messages, messageId): {ids: string[]; index: number}` — scan subagent tool rows (`role === 'tool' && subMessages`), link turn B after A when `parseSubagentInput(B.toolInput).session_id === parseSubagentMarker(A.toolResult)`; WeakMap-cache parses, skip caching while `toolStatus === 'running'`. Matching only tool rows means a model quoting a marker in prose can't forge a link.
12. `lib/subagent-group.ts`: add `continued: boolean` to `SubagentRow` (from `!!input.session_id`); for the group row, fold `'continued'` into the existing `' · '` meta string (zero markup change).
13. Cards: `SubagentRunCard.svelte` — small "continued" affordance in the name block (~line 77, phosphor `ClockCounterClockwiseIcon`); `SubagentReturnCard.svelte` — third small-caps kicker segment (`· CONTINUED`) in the kicker row (54-79); `SubagentRow.svelte` — covered by the meta string.
14. `SubagentPane.svelte`: `$derived` chain via `subagentChain(currentSession?.messages ?? [], messageId)`; "Turn N of M" + prev/next in the chrome row (~121-131) calling `panes.openSubagent(tabId, id)` — the pane derives everything from `messageId` and isn't keyed, so swapping the id is sufficient.
15. No `session-transcript.ts` changes: toolInput/toolResult already replay, so chip + chain restore after reload. Child `subMessages` stay empty on reload (accepted; backfill is the follow-up).

## Phase 5 — tests

- Marker round-trip through both reload paths (`claude-session-helpers` parse; `codex-utils` `codexItemToMessage`) — extends `tests/unit/subagent.test.ts` / `codex-event-normalizer.test.ts` patterns.
- Listing/search exclusion: a registered child is absent from `listIndexed*Sessions` and `searchIndexedSessions` results but still resolvable by id (the `read_session` interop contract).
- Resume validation (wrong provider / foreign parent / unknown id) + concurrent-resume guard.
- `subagentChain` linking incl. new-id-per-resume (each turn's marker is the next turn's input id).

## Residual risks (accepted, documented)

- Codex `dynamicTools` on resume rides the same experimental app-server capability as normal resumed sessions (`dynamicToolsUnavailable` fallback at `codex-backend.ts:316-321`).
- A same-turn resume adjacent to another subagent call groups as "N agents in parallel" (`turns.ts:41`) — cosmetic; revisit group title later if it bothers.
- Codex app-server restart between turns: fine (rollout on disk); Claude fine (jsonl on disk).

## Verification

1. `bun run build` — compiles clean.
2. Unit tests above via the repo's test runner.
3. Manual e2e (dev app already running → use dev.log, or `.claude/skills/run-app`): in a Claude session, ask the parent to delegate a task to a Codex subagent, then a follow-up that requires remembering the first turn ("what did I ask you before?"). Confirm: marker line in first result; second call passes `session_id`; child answers from prior context; two cards render with continued chip + pane turn nav; session picker and `search_sessions` show no child sessions, but `read_session` with the child id returns its transcript (the interop contract). Repeat with a Codex parent → Claude child. Reload the session: chip + chain nav survive; resume still works after full app restart.
