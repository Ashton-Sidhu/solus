# Multi-Host Parity — every native feature works for remote and dispatched sessions

**Goal:** a feature that works for a local session works identically for a session on
any connected host, or is explicitly gated with a visible reason. Host-correctness
becomes structural — enforced by types, keys, and lint — instead of a per-call-site
convention that each feature must rediscover.

**Status: accepted.** WP0 questions resolved 2026-08-09: works federate by fan-out
with owner-host writes; GitHub API access on non-primary hosts is an inline per-host
connect; the `HostApi` cutover is hard — no backwards-compatibility layer. The two
ADRs below still get written, recording these decisions.

- **Decisions**: [ADR-0008](../adr/0008-the-renderer-addresses-hosts-not-an-ambient-api.md)
  (host-addressed renderer API, local api split, hard cutover) and
  [ADR-0009](../adr/0009-every-domain-declares-its-host-ownership.md) (the domain
  ownership table and credential rule) — both written and accepted. It builds on
  [ADR-0005](../adr/0005-publish-typed-host-events-to-explicit-clients.md) (per-host
  event subscribers), [ADR-0006](../adr/0006-the-task-host-is-the-projects-host.md)
  (a run names two hosts), and [ADR-0007](../adr/0007-clients-ferry-cross-host-writes-through-an-outbox.md)
  (the outbox).
- **Prior art**: `tasks.store.svelte.ts` is the only fully multi-host store and is the
  template for every store migration here. [dispatch-parity.md](./dispatch-parity.md)
  closed this same gap class for the tasks domain.
- **Evidence**: the full audit lives in the "Multi Host Native Gaps" task
  (01KZKMGDEZEHP4RWBX8RA09KAX) comments — three renderer audits, one seam analysis,
  and a comparison study of how T3 Code solves the same problem.

## The deficiency, precisely

The audit found ~40 broken surfaces, but they share five structural causes. Fixing
surfaces without fixing causes resets the clock: the next feature will be written
against the best-documented path, which is the wrong one.

1. **The wire has no host.** `RpcEnvelope` is `{method, args}` (`src/shared/rpc.ts`);
   host = which socket you call. `src/main/` is deliberately host-blind (ADR-0007), so
   a misrouted request answers from the wrong machine's database with no error. (We
   keep this choice — T3 Code makes the same one — but compensate at the client edge.)
2. **The type system cannot tell right from wrong.** `serverConnections.apiFor(serverId)`
   returns `SolusAPI`; `window.solus` is `SolusAPI`; `apiForRun` casts between them.
   Every host-wrong call typechecks.
3. **The wrong default is free.** `apiFor()` / `eventsFor()` with no argument mean
   "primary". `window.solus` rebinds when the user switches hosts. Counts at audit
   time: 186 ambient `window.solus.` call sites vs ~85 host-resolved; 12 of 23 event
   subscriptions primary-only.
4. **Stores are host-less singletons.** `prsStore`, `worksStore`, `automationsStore`,
   `runStore`, `planStore` bind implicitly to `window.solus`. Only `tasks.store`
   internalized multi-host.
5. **Nothing enforces anything.** No linter exists; `AGENTS.md` documents
   `window.solus.<method>()` as the architecture.

Two data-layer causes compound these: per-host SQLite with no cross-host reads
(works, plan annotations, automations, project config), and **path-as-identity**
(`SessionEnvironmentStore`, run, project-config, automation cwds key by bare path, so
identical paths on two hosts silently alias).

## Vocabulary (locked)

- **host api** — a `SolusAPI` handle bound to one host, obtained only by naming a
  `serverId`. After WP1 this is a distinct TypeScript type (`HostApi`).
- **local api** — the client-shell surface that is genuinely about the user's device:
  dialogs, `openExternal`, clipboard, window/tray/shortcut control, client settings.
  Never carries session, git, file, or domain data.
- **primary** — the host the client booted against. A UI default for *new* work and
  the answer for client-global reads; never a fallback for session-scoped data.
- **owner host** — the host whose database holds a given record (a work, a PR
  checkout, an automation). Reads and writes for that record route there.
- **scoped ref** — an id paired with its host: `(serverId, sessionId)`,
  `(serverId, path)`. Bare ids do not cross feature boundaries after WP1.
- **domain class** — every domain is classified exactly one of:
  - **host-scoped**: data lives on an owner host; UI fans out reads and routes writes
    (tasks today; PRs, works, plans, automations, run after this plan).
  - **client-global**: data belongs to the client device (keybindings, UI prefs,
    pinned-session manifest).
  - **gated-local**: capability only meaningful on the client's machine (terminal,
    reveal-in-Finder, open-in-editor); hidden or disabled with a reason for remote
    sessions, per the `ActionOrb` pattern.

## WP0 — Decisions (done: ADR-0008 and ADR-0009 are written)

**ADR-0008: the renderer addresses hosts, not an ambient API.**
- `window.solus` shrinks to the local api. All domain calls go through host apis.
- `HostApi` is a branded type (`SolusAPI & { readonly __host: unique symbol }` or a
  wrapper interface); `serverConnections.apiFor(serverId: string)` (argument now
  required) is the only producer. `eventsFor(serverId: string)` likewise.
- A named `primaryApi()` / `eventsForPrimary()` exists for legitimately client-global
  or primary-scoped reads, so "primary" is a visible choice at the call site, not an
  omission.
- Session identity crossing a feature boundary is a scoped ref. `SessionMeta.serverId`
  is always populated by the client edge that received it.
- On connect, the client verifies the host's self-reported `installationId` (already
  in `/health`) against the saved server record and refuses on mismatch.

**ADR-0009: domain ownership.** One table classifying every domain
(host-scoped / client-global / gated-local) with its owner-host rule. The
classifications are baked into WP3–WP6 below; the ADR records them once instead of
per-PR. The two product questions are **decided**:
1. **Works**: union via fan-out reads, owner-host writes — the tasks pattern.
2. **GitHub API credentials on non-primary hosts**: per-host login, surfaced inline
   ("Connect GitHub on <host>") exactly where an operation needs it. Git delegation
   stays as-is; API tokens are never forwarded between hosts.

## WP1 — Foundations

Everything later depends on these five changes. They are mechanical but wide. Per
the WP0 decision the cutover is **hard**: `window.solus` shrinks and the branded
types land together, every ambient call becomes a compile error, and the WP1 series
merges only when the tree typechecks again. The compiler is the migration tool —
no deprecation alias, no baseline file tracking ambient calls.

**1.1 Split the API types.**
- Add `HostApi` brand. `serverConnections.apiFor/eventsFor` require `serverId` and
  return branded handles. `workspace.apiForRun/apiFor/apiForSession` return `HostApi`
  and drop the `typeof window.solus` casts.
- Add `localApi` (new module in `src/client-core/`) exposing only the local surface;
  desktop backs it with the preload bridge, web with the no-op/browser equivalents
  that already exist in `no-host-api.ts` / overlay code.
- Fix the `apiForRun` short-circuit: `LOCAL_SERVER_ID` with no registered local
  connection must resolve through `serverConnections.resolveId`, not `window.solus`
  (`workspace.context.svelte.ts:526-531`) — today a desktop whose primary is a saved
  remote sends "local" runs to that remote.

**1.2 Scoped refs for sessions.**
- `SessionMeta.serverId` becomes required at the client edge: every code path that
  builds or receives a `SessionMeta` stamps the host it read it from
  (`session-history` sources already do; the index-read helpers don't).
- `session://` links gain a `serverId` param; `resolveSessionLinkMeta` and
  `resumeSession` consume it. Old links without one resolve by asking every
  connected host (`connectedServerIds()` probe), not by assuming primary.

**1.3 Event fan-out as the default idiom.**
- Extract the tasks-store pattern (`onConnectionCreated` + per-host subscribe +
  unsubscribe on release) into one helper in `src/client-core/`:
  `subscribeAllHosts(topic, handler)` where the handler receives `(serverId, payload)`.
- `eventsFor()` loses its no-arg form (1.1); the ~12 primary-only subscriptions are
  migrated to either `subscribeAllHosts` or an explicit `eventsForPrimary()` in the
  domain WPs below.

**1.4 Host-qualified keys.**
- One key helper: `hostKey(serverId, path)`. Migrate `SessionEnvironmentStore`
  (`byCwd`, `refsByRoot`, `apiByCwd`, refresh/version maps) to it; `apiForCwd`'s
  `window.solus` fallback becomes "no entry → no call" (empty, never primary).
- `review-guide.store` keys state by `serverId` instead of api object identity (a
  released and re-created connection currently resets its state).

**1.5 Host identity verification.** On transport connect, compare `/health`
`installationId` with the saved server record; surface a typed mismatch error in the
connection UI. One-time backfill: stamp `installationId` on saved servers at first
successful verify.

**1.6 Enforcement.**
- The hard cutover makes the type system the primary enforcement: after 1.1,
  `window.solus` is typed as the local api only, so an ambient domain call does not
  compile. Boot files (`main.ts`, `native-api-overlay.ts`, preload) and `localApi`
  internals are the only modules that touch the raw bridge.
- One slim oxlint rule as belt-and-braces: ban re-widening escapes (`as HostApi`,
  `as any`/`as SolusAPI` on api handles) outside `serverConnections`, so the brand
  cannot be counterfeited at a call site. Wire into `package.json` + CI.
- Update `AGENTS.md`/`CLAUDE.md` "How Solus works" to document the host-api path as
  the architecture and the local api as the exception.

**Verification:** unit tests for `resolveId`/short-circuit behavior, `hostKey`
collisions, link parsing round-trip; `bun run build` and svelte-check green across
all three targets — with the hard cutover, a green typecheck *is* the proof that no
ambient domain call survives.

## WP2 — Session lifecycle cluster (small diffs, immediate user pain)

- The six `getSessionInfo` sites resolve on the session's host or probe all hosts:
  resume from task page/link (`workspace.context.svelte.ts:2646`,
  `TaskPage.svelte:182`, `TaskSection.svelte:115`), sidebar child rows and pinned
  sessions (`session-sidebar.store.svelte.ts:635,784` — pinned manifest entries gain
  `serverId`, a client-global store holding scoped refs), transcript links
  (`session-link.ts:16` via 1.2), session labels (`session-labels.svelte.ts:29`).
- `TaskPage` stop button routes via `tasksStore.hostFor` (`TaskPage.svelte:199`).
- Queued prompt cancel/edit use `apiFor(tabId)` like their sibling send-now
  (`QueuedPromptGroup.svelte:67,75`).
- `SessionPicker` live refresh subscribes per host (`SessionPicker.svelte:418` →
  `subscribeAllHosts`).
- `openExternalEditor` gains the `serverId === LOCAL_SERVER_ID` gate that
  `ActionOrb`'s terminal already has; remote sessions show the gated tooltip.

**Verification:** unit tests on resume-meta resolution (remote meta → remote tab);
manual check that a dispatched task's session resumes with its transcript.

## WP3 — PR surface

Domain class: **host-scoped**; owner host = the host holding the checkout/worktree
the PR context refers to (for a session-launched review, the session's host).

- `PrsStore` adopts the tasks template: methods take a `HostApi` or scoped ctx
  (callers already hold a session/tab), caches key by
  `hostKey(serverId, contextKey)`, events via `subscribeAllHosts` for
  `prs.invalidated`, `pr.guideStatusChanged`, `pr.checksChanged`; same for
  `stacks.store`.
- `openPrReviewRoute` resolves the api from the originating tab/section and threads
  it through the route ctx (`workspace.context.svelte.ts:2897`,
  `route-registry.ts:324`) — this also fixes the current split-brain where the diff
  uses the chat tab's host while threads/worktree used primary
  (`PrReviewPane.svelte:786`).
- `PrReviewPane` passes `getApi` into `GuideLoader`/`ReviewDrafts`
  (`PrReviewPane.svelte:139-176`, matching `ReviewGuidePane.svelte:62,79`);
  `SubmitReviewModal`, `MergeControl`, `ActivityFeed` take the pane's api.
- `ReviewGuidePane` fixes: persist `sourceTabId` in the restored route so a
  deep-linked review doesn't fall back to `activeTabId` (`ReviewGuidePane.svelte:46`);
  "send feedback to agent" passes `serverId` into `createTab`
  (`ReviewGuidePane.svelte:104`).

**Verification:** review a PR from a dispatched session end-to-end on a two-host dev
setup (worktree opens on the session's host; threads, submit, merge route there);
unit tests for store ctx threading.

## WP4 — Attachments and artifacts (bytes cross the boundary, paths do not)

- **Attachments**: replace path-based attach for non-images with inline bytes. The
  composer reads the picked file (local api file dialog still fine), ships
  `{name, mime, dataUrl}` in the prompt payload; the session's host writes it under
  its own data dir and substitutes the host-local path before the agent sees it
  (`prompt-composer.ts:94` stops emitting client paths). Size-cap and count-cap in
  the shared contract. Images already ride as dataUrls — they converge on the same
  path.
- **Artifacts/images**: add `assetCreateUrl(ctx, resource) → {relativeUrl, expiresAt}`
  RPC returning an HMAC-signed, short-TTL URL served by the owning host's HTTP
  server. `ArtifactView` and `markdown-image` resolve through the session's host api
  + that host's HTTP origin instead of `solus-artifact://` local-disk reads. The
  Electron protocol stays as a fast path only when
  `run.serverId === LOCAL_SERVER_ID`. This also gives the web client artifact
  rendering, which it currently lacks entirely.
- `AttachmentChips` preview passes its `tabId` so previews resolve on the right host.

**Verification:** unit tests for signed-URL mint/verify (TTL, path canonicalization
under the project root, extension allowlist); dispatched session renders a
`render_artifact` image on desktop and web.

## WP5 — Works and plans

Domain class: **host-scoped**, owner host = the host of the session that created the
record (or primary for works created outside any session).

- `WorksStore` adopts the tasks template: `hostByWorkId`, `loadAll` fans out across
  `connectedServerIds()` and unions (dropping the current evict-unknown behavior at
  `works.store.svelte.ts:241-245`), writes (`save`, `delete`, `duplicate`, `pin`,
  `revert`, `linkWorkSession`) route to the owner host, `ensureContent` cold path
  loads from the owner host. Session-stream inserts (`work_created`) stamp the
  emitting host.
- Work annotations follow the work: `DiagramShell.svelte:215` and
  `DocumentModal.svelte:95` go through the store, which routes to the owner host —
  agent and user finally see the same comments.
- `createWork` from the workspace creates on the active session's host with that
  host's cwd (`workspace.context.svelte.ts:2501`).
- **Plans**: annotations, status, bookmarks, `listPlans`, `loadPlanContent`, and
  `writePlanFile` route via the session's host (`plan.store.svelte.ts:152-493`) so
  the remote agent's `read_plan`/`review_plan` sees user comments — closing the
  one-way review loop. Plan gallery fans out like works.
- Google export stays primary (primary owns Google auth) — documented in ADR-0009.

**Verification:** two-host test: remote agent `create_work` → survives gallery load
and app restart; user comment on remote plan → remote `read_plan` returns it.

## WP6 — Automations, run, project-config, settings framing

- **Automations** (host-scoped; owner host = where it is stored and scheduled):
  store fans out reads and routes writes; builder gains a host picker and passes
  `api` into `DirectoryPicker` (already supported); `automation.*` events via
  `subscribeAllHosts`; project-panel matching keys by `(serverId, cwd)`
  (`ProjectPanel.svelte:134-146`). Creating from a remote session's context defaults
  the host to that session's host.
- **Run** (host-scoped by the session's host): `RunSection` and `run.store` take the
  session's api; `run.statusChanged` via `subscribeAllHosts`; `openPort` builds the
  URL from the host's origin for remote hosts (or gates with a tooltip when the
  host has no reachable HTTP origin) instead of always `localhost`
  (`RunSection.svelte:71`).
- **Project-config**: editor loads/saves via the session's host api
  (`project-config.store.svelte.ts:9,22`) so the config the agent honors is the one
  the user edits.
- **Settings**: tools, skills, voice, and projects tabs adopt the Connections tab's
  host framing (`host-setup.store.svelte.ts` pattern) — a host selector where the
  data is host-scoped, explicit "on <host>" labels elsewhere. GitHub/provider
  connect per host already exists in Connections; the Providers tab points there for
  non-primary hosts.

**Verification:** per-domain focused tests (store fan-out, owner-host writes);
`ProjectPanel` automation matching test with same-path-two-hosts fixtures.

## WP7 — Capabilities, credentials, notifications (follow-on)

Deliberately after the parity work; each needs its own decision.

- **Capability advertisement**: hosts advertise capability flags (in `/health` or a
  `getCapabilities` RPC) — available editors, terminal, browser-open — replacing
  ad-hoc `desktopHandlersAvailable` checks; clients hide or gate actions the host
  does not advertise. Absent flag = unsupported (version-skew safe).
- **GitHub API on non-primary hosts**: per ADR-0009 decision — surface "Connect
  GitHub on <host>" inline where an operation needs it (task upstream sync already
  routes correctly and only lacks the credential).
- **Notifications**: today the push plumbing is client-dormant and per-host. Scope a
  separate plan: client subscribes on every retained host, or a relay. Out of scope
  here beyond noting the constraint.

## Sequencing and mechanics

Order: WP0 → WP1 → WP2 … WP6 (each WP is a PR-sized concern or a small series;
one domain per PR, per the house rule). WP1 is the exception to PR-sizing: the hard
cutover is one coordinated series on a branch — land the type split, fix every
compile error domain-by-domain within the series, merge when green. WP2 can start
once 1.1–1.2 land; WP3–WP6 are independent of each other after WP1 and can be
parallelized. Definition of done for the migration: the tree typechecks with
`window.solus` typed as the local api, and the re-widening lint reports zero.

**Two-host test rig**: a second standalone server with a worktree-local
`SOLUS_DATA_DIR` (per the development-safety rules) is the verification environment
for every WP; add a `scripts/` helper to boot one against a fixture project so
"dispatched session" checks are one command.

**Out of scope**: making `src/main/` host-aware (the host stays deliberately
host-blind per ADR-0007); cross-host data sync/replication services; mobile-specific
UI beyond what the shared web client provides; the notifications relay.

## Risks

- **Churn radius of the hard cutover**: the brand + required-arg change touches
  every store, and the WP1 branch does not build until all ~186 sites are resolved.
  Accepted by WP0 decision (no backwards compatibility). Mitigations: fix sites
  domain-by-domain inside the series so review stays per-concern; sites whose
  domain migrates later (WP3–WP6) get the mechanically correct routing (thread the
  session's `HostApi` or an explicit `primaryApi()`) without the domain's full
  federation work, which follows in its own WP.
- **Fan-out cost**: `connectedServerIds()` is small (connections the app already
  holds), and tasks-store proves the pattern's perf; stores must still not conjure
  sockets to saved-but-unused hosts (use existing `withTemporaryConnection` for
  one-shot probes).
- **Same-id collisions across hosts** (works/plans use content-addressed or
  host-minted ids): scoped keys make collisions harmless in the client; the ADR-0009
  table records each domain's id-uniqueness assumption.
