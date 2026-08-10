# Session-First Drafts

**Goal:** stop creating a `Session` and a `Tab` just to have somewhere to type. A `SessionDraft` owns a plain, mutable `{ prompt, run, task }`; dispatch reads it and *then* creates the session and mounts a tab. The new-tab home becomes its own pane, addressed by the router.

**Status:** builds on the working-tree change that deletes `draftTabId` and makes draftness derived (`isDraftTab` = `!hasSessionStarted`). **Land that first** — it is a prerequisite, not a competitor. This plan removes what it left behind: `createDraftTab`, `seedComposerTab`, `openedFromTabId`, and the task fields it added to `PersistedTab`.

**Status: complete.** WP1–WP6 are implemented in the working tree. Build green; `svelte-check` 248 against a 250 baseline (two real pre-existing errors fixed en route); `client/` carries no error from this work; unit failures 78 = 78 baseline.

The inversion is done. A `SessionDraft` owns `{ prompt, run, task }` and has no session and no tab; `createSession` is the only way one comes into existence from the UI. `createDraftTab` and every one of its ~20 callers are gone, along with `isDraftTab`, `isFreshTaskDraft`, `seedComposerTab`, `Tab.openedFromTabId` and the `closeTab` empty-workspace repair.

- **`run-config.ts`** — pure rules, each returning a new value: `inheritRunConfig`, `withCheckout`, `withWorktreeToggled`, `withHost`, `withProjectHost`, `withPendingHost`, plus the answers `projectRootOf`, `isDispatch` and `startsWorktree`. Nothing mutates a run config behind a call; every site reads `x.run = withY(x.run, …)`.
- **`Session` composes** `run: RunConfig` and `task: TaskTarget`, so a draft and a started session are interchangeable everywhere below the pane. `PersistedTab` keeps the three flat task fields for backwards compatibility, converted at the boundary.
- **`Session.prompt`** — the unsent message moved off the tab. Two views of one conversation now share it rather than holding two drafts only one of which could be sent.
- **Drafts persist** on their own `solus-session-drafts` key, restored before the location so a saved `draft/<id>` route resolves.

**Corrections made to this plan while implementing it, worth keeping:**

1. **`NewTabHome` does not delete.** It renders a *tab whose session has not started*, which `createTab`'s ten-plus callers still produce. That is a different concept from a draft, and only the draft one went away.
2. **`retargetSessionHost` was misnamed** and is now `moveTabToHost`. A session never moves between machines; the tab's speculative registration does, and only before anything has started.
3. **`RunOnPicker` never moves anything.** It records intent — host, project-on-host, worktree are one kind of edit, inert until Send — so its ten props collapsed to `run`, `onRun`, `requesterId`, `locked`, `variant`.


**Verification gap — read this before trusting a green check.** `tsconfig.json` has `include: ["src/**/*"]`, so **neither `client/` nor `tests/` is typechecked** by the project's own tooling, and `bun run build` does not typecheck `.svelte` at all. The `session.run` migration silently left 39 broken field accesses in `client/` for exactly this reason; they were found only by pointing svelte-check at a temporary tsconfig that includes `client/src/**/*`. Verify all three targets:

```
bunx svelte-check --tsconfig ./tsconfig.json          # src/  — 250-error baseline
bunx svelte-check --tsconfig <tmp with client/src>    # client/
bunx tsc -p <tmp with tests/>                         # tests/
```

Also note `sort` collation differs by shell PATH — pin `LC_ALL=C` when diffing recorded failure lists, or identical sets read as wholly changed.

**Baseline note for anyone verifying:** `tests/unit/setup-handlers.test.ts` → *"the destination host clones when its own project registry has no checkout"* is **order-dependent**, not a regression. It passes 5/5 in isolation and appears intermittently in full-suite runs on clean `HEAD` too. Diff full-suite failures against a recorded baseline rather than reading a raw count, and re-run once before believing a single new entry.

## Vocabulary (locked — do not invent synonyms)

- **`SessionDraft`** — a prompt being written that has no session and no tab. Holds `{ prompt, run, task }` and nothing else. Mutated in place: pointing it elsewhere is `draft.task = …`, never a destroy-and-rebuild that has to carry state across its own seam. This is the *only* sanctioned use of the word "draft".
- **`SessionSpec`** — a draft's plain, serializable shape (`draft.spec`). What persists, and what `createSession` consumes.
- **`Prompt`** — what you typed: `text`, `attachments`, `planRefs`, `workRefs`, `sessionRefs`, `savedPromptId`. This is today's `InputState`, renamed. It contains **no view state** — no caret, no selection, no focus. Those live in the Tiptap instance and are never serialized.
- **`RunConfig`** — how the session will run: `workingDirectory`, `worktree`, `modelConfig`, `permissionMode`, `provider`, `serverId`, `taskServerId`, `sessionSkills`, `pendingHostDispatch`. Resolves into the existing `SessionRunInput` (`shared/types.ts:1367`) at dispatch.
- **`TaskTarget`** — what the resulting session belongs to. A union, not a bag of booleans:
  ```ts
  type TaskTarget =
    | { kind: 'existing'; taskId: string }
    | { kind: 'new'; parentTaskId?: string }
    | { kind: 'none' }
  ```
- **Draft pane** — the surface bound to one `SessionDraft`. Addressed as a route: `{ name: 'draft', params: { draftId } }`.
- **Dispatch** — `createSession(spec)`. Resolves `run` → `SessionRunInput`, starts the session, mounts a tab, then applies `task`.

**Never** reintroduce the *tab* sense of draft: "draft tab", `draftTabId`, `isDraftTab`, `createDraftTab`. A `SessionDraft` is not a tab in any state — it is what exists *instead of* one. Do not coin "composer" for it either; that word already means the input bar UI.

**Verify after every work package:** `bun run build` (warnings/errors only) and `bun run test:unit`. Do **not** start a dev server; if one is running, read `dev.log`.

**House rules (from CLAUDE.md — binding):** mutate `$state` in place (never spread-replace); `$derived` over `$effect`; logic in sibling `lib/*.ts`, not `.svelte`; static Tailwind inline; dark + light mode; keyboard-navigable; surgical diffs; delete orphaned code; never `git revert`.

---

## Background: why

The backend already models this correctly. `ControlPlane`'s own doc comment (`control-plane.ts:173-179`):

> Tabs are thin subscription records. All session state lives in `BackendSession` (keyed by agent session ID in `activeSessions`). Tabs point to sessions via `tab.sessionId`.

And session-without-tab is not hypothetical — it ships. `control-plane.ts:582`: *"a headless agent (created via `create_session`, card not yet opened) still needs its exit lifecycle."* The MCP path creates and runs sessions with zero tabs.

`SessionRunInput` is already the caller-agnostic run contract, and says so:

> Any system (the renderer, automations, a future HTTP/MCP caller) can build this plain object directly to start, resume, or send a message, instead of fabricating a full IpcContext snapshot.

**The renderer is the one caller that cannot build one.** It fabricates a `Session` first (`types.ts:585-617`), types into `tab.input`, then reads the config back off the session at dispatch (`workspace.context.svelte.ts:1718`). Everything below follows from that inversion:

1. **Empty drafts occupy every list.** A composer tab is a real tab in `tabOrder`, so it gets a tab-strip entry and a sidebar row before it has done anything. The sidebar WIP swapped a hand-fabricated `SidebarTask` for a real loose row — both put an empty composer tab in the column.
2. **Re-aiming destroys and rebuilds.** Changing a composer tab's task destination runs `discardDraftTab` + `createDraftTab`, which is why `preservedInput` and `openedFromTabId` exist: to carry state across a rebuild that should never happen.
3. **`taskCreationDisabled` is a union apologizing for being a boolean.** `createDraftTab` computes `'existing' | 'none' | 'new'` inline from three loose fields and throws it away.
4. **Invented invariants.** `seedComposerTab` (`session-bootstrap.ts:104`) and the `closeTab` repair (`workspace.context.svelte.ts:1332`) exist so no surface has to describe a workspace with no tab.
5. **Session state persists through a view record.** `PersistedTab` now carries `pendingTaskId`, `pendingParentTaskId`, `taskCreationDisabled` — none of which are tab state — because tabs are what get persisted.

## Locked design decisions (do not re-litigate)

1. **A `SessionDraft` has no session and no tab.** Nothing appears in the tab strip until dispatch, and nothing appears in the *task* list either: `visibleTabIds` (`session-sidebar.store.svelte.ts`) derives from `tabOrder`, and a draft is not in it. **Amended:** the sidebar now carries a separate **Drafts** section above the tasks, listing drafts that were written in. See "Drafts in the sidebar" below.
2. **The new-tab home is its own pane**, a `draft` route with `placement: 'any'` and `keepAlive: true`. A pane shows a session or a draft.
3. **`draftId` in route params is identity only.** The draft persists beside it, never in the URL — `route-registry.ts:16` requires params be "the identity of a destination, never a live payload."
4. **A `SessionDraft` is mutable and long-lived.** Pointing it elsewhere is `draft.task = …`. Never destroy-and-rebuild one.
5. **The three parts have different fates at dispatch.** `prompt` and `run` carry onto the session; `task` is superseded by a `task_session_links` row and is not kept.
6. **`InputBar` is controlled.** It receives a `Prompt` and mutates it. It does not resolve its own state and does not know whether the prompt came from a draft or a session.
7. **`Prompt` never holds view state.** Caret, selection, focus and IME stay in the Tiptap instance.
8. **`TaskTarget` replaces `pendingTaskId` + `pendingParentTaskId` + `taskCreationDisabled` everywhere.** No parallel representations.

## Target contract (WP1–WP3 deliver this)

```ts
// shared/types.ts — replaces InputState
export interface Prompt {
  text: string
  attachments: Attachment[]
  planRefs: PlanReference[]
  workRefs: WorkReference[]
  sessionRefs: SessionReference[]
  savedPromptId: string | null
}

/** How the session will run. Resolves into SessionRunInput at dispatch. */
export interface RunConfig {
  workingDirectory: string
  /** Null when working directly in the checkout; see ADR-0006. */
  worktree: { baseBranch: string | null } | null
  modelConfig: ModelConfig
  permissionMode: 'ask' | 'auto' | 'plan'
  provider: AgentId | null
  serverId: string
  /** Where its task lives — see ADR-0006. Differs from `serverId` on a dispatch. */
  taskServerId: string
  sessionSkills: string[]
  pendingHostDispatch: PendingHostDispatch | null
}

/** Where the resulting session gets filed. Never crosses the RPC boundary. */
export type TaskTarget =
  | { kind: 'existing'; taskId: string }
  | { kind: 'new'; parentTaskId?: string }
  | { kind: 'none' }

/** A draft's serializable shape. */
export interface SessionSpec {
  prompt: Prompt
  run: RunConfig
  task: TaskTarget
}
```

```ts
// contexts/workspace/session-draft.svelte.ts
export class SessionDraft {
  readonly id: string = uuid()
  prompt = $state<Prompt>(makePrompt())
  run    = $state<RunConfig>() as RunConfig
  task   = $state<TaskTarget>({ kind: 'new' })

  /** `inherit === null` IS "start fresh" — there is no separate flag, because
   *  starting fresh is exactly having nothing to carry over. */
  constructor(defaults: RunConfig, inherit?: RunConfig | null)

  get spec(): SessionSpec        // serializable shape: what persists, what dispatch reads
  applyRun(next: RunConfig)      // re-aim in place, prompt intact
}

/** The whole rule, as a plain function of two run configs. */
export function inheritRunConfig(
  defaults: RunConfig,
  inherit?: RunConfig | null,
  worktreeRequested?: boolean,
): RunConfig
```

**Everything a draft needs to know about its environment is already a
`RunConfig`,** so nothing else is passed in. There is no host interface, no
request object and no `fresh` flag — an earlier draft of this plan had all
three, and each turned out to be a `RunConfig` wearing a different name:

| Was | Is |
|-----|-----|
| `SessionDraftHost` (7 fields: globalDefaults, staticInfo, settings, fallbackServerId, effort lookup…) | `defaults: RunConfig` — `workspace.defaultRunConfig` |
| `SessionDraftRequest.anchor: Session` | `inherit: RunConfig` — the run of the session it was opened from |
| `SessionDraftRequest.fresh: boolean` | `inherit === null` |

Three fields deliberately do not carry over, because they describe one session's
history rather than where the next should start: `permissionMode` (an app-level
preference), `pendingHostDispatch` (inert until Send, so it belongs to the
session that chose it), and `modelConfig.reasoningEffort` (reset to the model's
own default via `MODEL_PROFILES`).


The open drafts live on the workspace context as a plain reactive map — **not** a
store class. There is no loading, no cache, no stale-guard and no remote source;
`src/renderer/CLAUDE.md`'s store rule is about `window.solus.*`-backed domain
state, which this is not.

```ts
// workspace.context.svelte.ts
sessionDrafts = new SvelteMap<string, SessionDraft>()
```

**Why drafts carry their own id rather than being keyed by pane.** Pane ids are a
per-boot counter (`newPaneId()` → `pane_1`, `pane_2`, …) and the codec serializes
panes *positionally*, storing focus as an index — so no pane id survives a
reload. A draft must (today's behaviour, and what the `PersistedTab` task fields
were added for), so it needs an identity of its own. That id is what the `draft`
route carries, which keeps route params pure identity per `route-registry.ts:16`.


Dispatch is one entry point on the workspace context:

```ts
/** Resolve `run` → SessionRunInput, start the session, mount a tab, apply `task`.
 *  The only way a Session comes into existence from the UI. */
async createSession(spec: SessionSpec, opts?: { paneId?: string }): Promise<string>
```

---

## WP1 — Types + `Prompt` rename (no behavior change)

**Files:** `shared/types.ts`, `contexts/workspace/session.factories.ts`, `tab-registry.svelte.ts`, `prompt-composer.ts`, `session-bootstrap.ts`, `tab-persistence.ts`.

1. Rename `InputState` → `Prompt` and `makeInputState` → `makePrompt`. 22 references across 6 files; the compiler finds every one.
2. Add `RunConfig`, `TaskTarget`, `SessionSpec`. Nothing consumes them yet.
3. Add `taskTargetOf(session)` in `session.utils.ts` — reads today's three fields into a `TaskTarget`. One adapter, deleted in WP5.

**Acceptance:** build + unit tests green, zero behavior change, `InputState` gone from the tree.

## WP2 — `InputBar` becomes controlled

**Files:** `components/input/InputBar.svelte` and its call sites.

1. Replace `const input = $derived(session.inputFor(targetTabId))` (`InputBar.svelte:87`) with a `prompt: Prompt` prop. The ~15 mutation sites below it already write through the local binding.
2. Call sites pass `session.inputFor(tabId)` — status quo, one hop moved outward.
3. Keep `tabId` for now: focus routing and session-scoped actions still need it. Removing it is WP4's job.

**Acceptance:** the bar resolves no state of its own. Typing, attachments, refs, saved prompts and slash commands all unchanged.

## WP3 — `SessionDraft` + `createSession(spec)`

**Files:** new `contexts/workspace/session-draft.svelte.ts` + `session-draft.store.svelte.ts`; `workspace.context.svelte.ts`; `tab-persistence.ts`.

1. `SessionDraft` plus the `SvelteMap` on the context, per the contract above. Drafts persist under their own key — **not** in `PersistedTab`.
2. `createSession(spec)` — extract from the second half of `sendPrompt` (`workspace.context.svelte.ts:1718` onward): resolve `run` → `SessionRunInput`, dispatch, mount a tab, apply `task`.
3. `createDraftTab` is rewritten to delegate: build a `SessionDraft`, dispatch through the new path. Its ~30-line `existingTaskMode`/`requestedTaskMode` comparison block goes — re-aiming is `spec.task = …`.

**Acceptance:** every existing entry point still starts a session; `createSession` is the only place one is created.

## WP4 — The `draft` route and pane

> **Scope correction, found during implementation.** The composer *chrome* —
> `InputBarHeader` (248 lines), `InputToolbar`, `TaskPicker`, `ProjectChip`, and
> the pickers they open — is uniformly addressed by `tabId`: each takes one,
> resolves `session.sessionFor(tabId)` to **read** its run target, and calls
> `session.setX(…, tabId)` to **write** it. ~30 such sites. A draft has no
> tab, so none of it resolves. Two sub-packages, below.
>
> A `ComposerTarget` union discriminating tab-vs-composer was considered and
> **rejected**: none of this is tab-*dependent*, it is all run configuration that
> happens to be reachable through a tab today. Every reader wants a `RunConfig`
> and nothing more.

### WP4a — `Session extends RunConfig` ✅ done

A started session carries the same ten fields a `RunConfig` does, meaning the
same things. Declaring that structurally is what lets one chrome edit either a
live session's target or a spec's proposed one, with no union and no dispatch:
`draft.run` for a draft, and the `Session` *itself* for a started tab — so the
tab case needs no copy and edits flow straight through to the live session.

Verified: the ten duplicated field declarations are gone from `Session`, build
green, unit failures unchanged.

### WP4b — the chrome reads a `RunConfig` ✅ done

**How it resolved.** Not by threading a `RunConfig` prop through every surface —
that produced an optional `run` beside every `tabId` and two ways to answer one
question. The tab id was never the problem; *looking a run up through a tab* was.
So the lookup moved onto the workspace and the id stayed:

```ts
/** The run a surface is scoped to, named by whichever thing owns it. */
runFor(sourceId: string): RunConfig | undefined
apiForRun(run: RunConfig | undefined): typeof window.solus
```

A `sourceId` is a tab id or a draft id, and every surface that describes *where
work happens* takes one: `ProjectPanel`, `EnvironmentSection`, `GitSection`,
`GitActions` (which dropped its tab entirely — Git acts on a checkout), and the
`files` / `fileEditor` routes, whose param is now `sourceId`. `IpcContextBuilder`
reads its run fields through `runFor` too, so a draft's context is the draft's
own rather than the app defaults. Because a draft id is already persisted
identity, none of the route grammars changed.

The tab dependency turns out to be shallow everywhere it appears:

- **`SessionEnvironmentStore.environmentFor(tabId)`** uses the tab only to reach
  `gitContext`, `worktree` and `workingDirectory` — three `RunConfig`
  fields. The store's own caches are keyed `byCwd` already. It takes a
  `RunConfig`; `globalDefaults` is the fallback it already falls back to.
- **`toggleWorktreeMode` / `switchToBranch` / `switchToWorktree` /
  `setBaseDirectory`** resolve a session and then mutate exactly those same
  fields. They take a `RunConfig` plus a cwd for the refresh, not a tab.
- **The four components** take `run: RunConfig`. A draft passes `draft.run`; a
  started tab passes `session.run` — the live object, so edits reach the session
  with no copy and no write-back.

Deferred deliberately: `InputBar` already takes its `prompt` (WP2), so its own
send path needs only an `onDispatch` hook — `sess` resolving to `undefined` on a
draft already yields the right idle/not-busy/not-read-only answers.

**Pane chrome, found the same way.** A surface owns its own header, but the
outlet (`ui/Pane.svelte`) neither supplies nor requires one, so a surface that
draws none is silently bare — which is how the draft pane shipped with no
breadcrumb, no rail and no close. `components/layout/AsidePaneShell.svelte` now
owns that header for every pane beside the leading one (`ConversationPane` and
`SessionDraftPane` both render through it), and `WorkspaceBody` owns the leading
pane's floating band for pool *and* draft alike — `ConversationView` no longer
draws one, it only reserves the room. `tests/unit/titlebar-safe-area.test.ts`
guards the header set by file, and caught the move.

**Files:** `routing/route-registry.ts`; new `components/session-draft/SessionDraftPane.svelte`; `layout/NewTabHome.svelte`; `WorkspaceBody.svelte`; `PillLayout.svelte`; `layout/lib/workspace-body.ts`; plus the WP4a set above.

1. Register the route:
   ```ts
   draft: {
     parse: (s) => (s ? { draftId: s } : null),
     serialize: (p) => p.draftId,
     placement: 'any',
     keepAlive: true,
     component: () => import('../../../components/session-draft/SessionDraftPane.svelte'),
   }
   ```
2. `SessionDraftPane` = today's `NewTabHome` headline + an `InputBar` bound to `spec.prompt`. `NewTabHome` loses its `tab` prop and reads the spec's `run.workingDirectory`.
3. ⌘T / "new tab" points the focused pane at a fresh `SessionDraft` instead of calling `createDraftTab`.
4. Delete `isHomeVisible`, the `centerHome` gate, and the home-mount branches in `WorkspaceBody`/`PillLayout`. The pane owns its own layout.

**Acceptance:** ⌘T opens a draft pane; nothing appears in the strip or sidebar; sending mounts a tab and the pane returns to `chat`. Two drafts can be open in two panes.

## WP5 — Retire draft tabs

**Files:** `workspace.context.svelte.ts`, `session-bootstrap.ts`, `tab-persistence.ts`, `shared/types.ts`, `session-sidebar.store.svelte.ts`, `TaskPicker.svelte`, `SessionBreadcrumb.svelte`, `SessionPicker.svelte`, `ProjectPanel.svelte`, both `App.svelte`s, `client/` layouts.

1. Delete `createDraftTab`, `isDraftTab`, `isFreshTaskDraft`, `discardDraftTab`, `seedComposerTab`, and the `closeTab` empty-workspace repair. Rewire the ~20 `createDraftTab` call sites to `new SessionDraft(this, request)` + register + a route navigation.
2. Delete `Tab.openedFromTabId` — its only job was surviving a rebuild that no longer happens.
3. Replace `pendingTaskId` / `pendingParentTaskId` / `taskCreationDisabled` with `TaskTarget`: ~60 references across 18 files, heaviest in `workspace.context.svelte.ts` (20) and `TaskPicker.svelte` (13). Drop them from `Session` and `PersistedTab`; delete `taskTargetOf`.
4. Delete `TabRegistry.activeInput` and `currentInput` — the orphan prompt for "no active tab" has no callers left.

**Acceptance:** `rg 'draft'` over `contexts/workspace/` returns nothing about tabs. An empty workspace renders a composer with no tab. Closing the last tab leaves a composer, not a synthesized tab.

## WP6 — Session owns the follow-up prompt

**Independently valuable; can land after WP5 or much later.**

**Files:** `shared/types.ts`, `tab-registry.svelte.ts`, `tab-persistence.ts`, `session-event-reducer.svelte.ts`, `InputBar.svelte`.

Move `Tab.input` → `Session.prompt`. Today two tabs on one session hold two independent unsent messages and only one can ever be sent; after this they mirror. `session-event-reducer.svelte.ts:784` is the existing sibling fan-out. Two bars on one prompt need the one-doc-many-views wiring — the non-focused bar mirrors read-only until focused.

**Acceptance:** the same session open twice shows one prompt in both bars; two sessions in split view stay independent.

---

## Sequencing

```
WP1 ──► WP2 ──► WP3 ──► WP4 ──► WP5 ──► (WP6, whenever)
```

Strictly sequential through WP5 — each touches `workspace.context.svelte.ts`, already 2777 lines. Keep new logic in `composer.store.svelte.ts` and colocated `lib/`, not in the context (flag >600 lines, hard-split >1000). One commit per package; `bun run build` and `bun run test:unit` before each.

**Test debt to expect:** `tests/unit/workspace-new-task-draft.test.ts` (17 draft references) and `tests/unit/workspace-resume-into-draft.test.ts` are written against the draft-tab model and need rewriting against specs in WP5, not patching earlier.

**Final integration check:** ⌘T opens a composer with nothing in the strip or sidebar · re-aiming a composer's task keeps its text and attachments · two composers coexist in two panes · a composer survives refresh · sending mounts a tab under the right task · closing the last tab leaves a composer.

## Out of scope (follow-ups)

`Tab.title` / `titleCustom` and `Tab.diffComments` / `diffGeneralComment` / `diffCommentDraft` are also session-shaped state on a view record — `sessionTitle(sess, tab)` already reaches across both to answer one question. Moving them collapses `Tab` to `{ id, sessionId, hasUnread }` plus its position in `tabOrder`, at which point it is a list row and can be replaced with any presentation model without touching session lifecycle. Not required by anything above.

## Drafts in the sidebar (follow-on, implemented)

The plan above left drafts unreachable once a pane moved on, so `openSessionDraft`
dropped whichever draft the focused pane was holding — "the old draft would be
unreachable and would leak". The sidebar's **Drafts** section removes that reason
and lets a person keep as many unsent prompts as they want.

**Vocabulary:** a *draft* is the `SessionDraft` this plan defines. There is no
second noun. The section is called **Drafts**; a row in it is a *draft row*
(`DraftRow`, `components/session/lib/draft-list.ts`).

**Rules:**

1. **A draft is listed once it is written in *and* set aside.** Two tests, both
   in the projection: `SessionDraft.isEmpty` (no text, no attachments), and
   whether a pane's `base` still names it (`composingDraftIds`). Every new-task
   gesture opens an empty draft and boot seeds one, so listing empties would
   fill the column with rows nobody wrote; and the prompt on screen is the one
   being typed, not one that was parked, so a row beside it would be the same
   words twice. Moving a pane off a written draft is what files it.
   `isEmpty` is also the rule every release path uses.
2. **A pane releases the draft it holds before showing anything else.**
   `releaseDraftIn(paneId)` drops it when it is empty and keeps it otherwise.
   `leaveDraftInLead`, `openSessionDraft` and `openDraft` all go through it.
3. **A draft is named by its first written line**, collapsed and capped
   (`draftTitle`). Files-only drafts say so. There is no stored title and no
   rename: a draft exists to become a session.
4. **`discardSessionDraft` returns the discarded `SessionSpec`** and hands back
   any pane that was composing it, so a sidebar discard can offer Undo through
   `restoreSessionDrafts` and never leaves a pane pointed at nothing.
5. **Drafts remain client-local.** They persist in `localStorage`, so they do not
   follow a user between desktop, web and phone. Syncing them would need a
   server store, RPC and an event topic; not done, and not implied by the row.

6. **Drafts are a section above Tasks, not rows inside it.** They share the
   section header (`TaskListHeader`, whose view toggle is now optional — a draft
   belongs to no project tree, so there is nothing to group it by) and cap their
   own height, so a run of drafts scrolls within itself instead of pushing the
   task column off the panel.

**Surfaces:** desktop/web sidebar (`SessionSidebar.svelte` + `DraftRow.svelte`)
and the mobile list (`client/src/components/MobileSessionList.svelte`), both
reading `SessionSidebarStore.draftRows`.
