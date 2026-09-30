# Plan: work editing foundation

Status: planned; no implementation is authorized by this document alone.
Prepared 2026-09-29 against commit `fb020ccb` and the current working tree.
Parent: [Work review and live editing](work-review-and-live-editing.md).

## Purpose and order

Prepare works for revision history, review, and live editing. Give one work's
persistent rules to a server-side `Work` class, and one diagram's editing
rules to a client-side `DiagramDocument` class. Remove the separate write and
refresh paths that would otherwise make collaboration harder to implement.

These are foundation changes. They preserve current product capabilities.
They do not ship review UI, a commenter role, Yjs, presence, or offline editing.
There are no external users to support with parallel legacy APIs. Still
preserve existing developer works and sessions through normal migrations;
do not reset a database or discard an unsaved draft.

| Step | Deliverable | Depends on | Effort | Risk | Status |
|---|---|---|---|---|---|
| 1 | `Work`, content versions, and immutable revision storage | — | Large | Medium | Implemented |
| 2 | One content write path and work-scoped change events | 1 | Large | Medium | Implemented |
| 3 | Complete work history in Share transfers | 1–2 | Medium | Medium | Implemented |
| 4 | One host-safe document schema; local display state | — | Medium | Medium | Implemented |
| 5 | One open-work state model for local and cloud works | 2 | Medium | Medium | Implemented |
| 6 | `DiagramDocument` and a thin diagram shell | — | Large | High | Implemented |

Implement in this order for a serial handoff. Steps 1–3 are prerequisites for
the parent's history and review features. Steps 4–6 must land before live
editing. Each step must remain independently testable. Do not introduce an
unused replacement beside the old implementation: move callers and remove
the old path in the same step.

## Current state and evidence

Paths below are relative to the repository root.

- `packages/server/src/data/works/works.ts` owns SQL and most work functions.
  `saveWork` has an optional `expectedUpdatedAt` check. `agentSaveWork` stores
  the **prior** body without a version precondition. `revertWork` updates the
  newest revision in place. Human saves do not add revisions.
- `packages/server/src/data/works/api-operations.ts` owns API authorization,
  locking, version checking, and response conversion. Some direct RPC and
  outbox paths bypass that API class.
- `packages/server/src/execution/agents/tools/work-tools.ts` does not return a
  version in `read_work`. `update_work` reads the work again and supplies that
  fresh `updatedAt` to the save. This misses human edits made after the
  agent's earlier read. Its foreign-work branch queues a whole-body update.
- `packages/server/src/data/works/work-applier.ts` applies those outbox writes;
  `work-sync.ts` applies upstream pulls; `transport/handlers/folio-handlers.ts`
  exposes direct agent saves and restore.
- `packages/server/src/data/tasks/task.ts` is the class convention to follow:
  `Task.byId(scope, id)`, methods on one record, and `record()` at the boundary.
  Collection queries remain outside the class.
- `packages/server/src/db/database.ts` already provides
  `afterDatabaseCommit`. Use it for signals that must not escape rollback.
- `packages/contracts/src/work-transfer.ts` carries `work`, `annotations`,
  and one `previous` snapshot. Export/import in `works.ts` cannot preserve a
  complete history. `sync/runner-protocol.ts` validates the transfer outline.
- `packages/workspace-ui/src/contexts/works/works.store.svelte.ts` owns a work
  cache and an `agentRevisions` counter. `cloud-work-copy.store.svelte.ts`
  keeps another record and polls. `components/work/WorkPane.svelte` selects
  different refresh behavior for local and cloud works.
- `components/editor/DocumentEditor.svelte:248` assembles schema extensions.
  `components/document-shell/DocumentShell.svelte` adds custom blocks. The
  custom extension modules mix schema definitions with Svelte node views.
  Paths in this paragraph are under `packages/workspace-ui/src/`.
- `DocumentEditor.svelte:184–233` replaces `asset://` references in document
  nodes with display URLs, then repairs markdown using a client-local map.
  A shared document would expose those display changes to other clients.
- `components/editor/commentMark.ts` defines `planComment` as a document mark.
  `components/plan/lib/comments.ts` applies it. The external-comment highlight
  code in `components/work/lib/external-comment-highlights.ts` is an existing
  decoration example.
- `components/diagram/DiagramShell.svelte` is approximately 3,000 lines. It
  reconstructs a whole document from flow nodes, assigns nested `detail`
  documents, restores complete snapshots, and schedules saves. Its
  `lib/diagram-history.svelte.ts` stores serialized whole-document snapshots.

Critical current excerpts to compare before implementation:

```ts
// work-tools.ts — this is the version at write time, not at the agent's read.
const saved = await operations.updateWork(context, workId, { content, title }, existing.updatedAt)

// works.ts — restore changes an existing revision today.
UPDATE ${workRevisions}
SET content = ${row.content ?? ''}, updated_at = ${epochMs(meta.updatedAt)}
WHERE work_id = ${id} AND rev = (SELECT MAX(rev) FROM ${workRevisions} WHERE work_id = ${id})

// DiagramShell.svelte — a whole nested document is currently replaced.
if (owner) owner.detail = view;
```

## Boundaries and working rules

Read `AGENTS.md` first. Check `git status --short` and compare the excerpts
above with current source. This plan was written with unrelated changes in
the worktree; preserve them. Compare committed drift with:

```sh
git diff --stat fb020ccb..HEAD -- packages/server/src/data/works packages/contracts/src packages/workspace-ui/src/components/editor packages/workspace-ui/src/components/diagram packages/workspace-ui/src/contexts/works
```

Also inspect uncommitted changes in each file before editing it. A changed
line number is not a blocker; a changed ownership or version model requires
reconciling this plan before implementation.

In scope: the named work, editor, and diagram modules; their immediate
callers; focused contracts, transports, schema migrations, and tests needed
for these changes. New modules must stay in their owning feature. A shared
editor schema belongs in a small shared package, `packages/document-model/`,
which both the host and renderer can import without importing workspace UI.
Update package manifests and module-boundary checks as needed.

Out of scope: session orchestration refactors, a general entity framework,
new synchronization protocols, collaboration UI, review decisions/inbox,
notification infrastructure, and provider-specific implementations. Keep the
existing Google read-only rule and current mobile diagram behavior. Do not
resolve the parent's remaining product decisions by changing the UI here.

Do not run builds, start a dev server, or use live Solus data. Use temporary
fixture databases. Do not commit, push, or create a PR unless separately
requested. Use the normal SQLite and Postgres migration generator; inspect
its output and never modify unrelated migrations.

## 1. Give one work a class and separate versions from history

### Ownership

Create `packages/server/src/data/works/work.ts`. Use the existing `Task`
pattern, importing the wire type as `WorkRecord` to avoid a name conflict.
`Work.byId(scope, workId)` loads within the caller's record scope. An instance
keeps the canonical work id and organization from the stored row.

The class owns validation, read-only restrictions, content mutation, immutable
checkpoints, restore, and persistent single-work metadata commands. Move the
SQL implementation into the class or focused private storage helpers; do not
retain exported functions that merely forward to its methods. List, search,
creation, and transfer orchestration stay in small focused modules.

Use a concrete API of this form; match final option names across contracts:

```ts
const work = await Work.byId(scope, workId)
await work.updateContent({ content, expectedContentVersion, author, reason })
await work.restoreRevision({ revisionId, expectedContentVersion, author })
return work.record()
```

Every mutation rereads and locks the row **inside its transaction**. A loaded
instance is a snapshot, not a lock. Serialize only plain records through
RPC/HTTP. Do not put connection state, Yjs rooms, or provider clients on
`Work`; those belong to their existing service or the later `WorkLiveManager`.

### Three separate concepts

- `contentVersion`: a persisted integer, advanced for each accepted change
  to the body. Equal-body writes do not advance it. A restore to earlier
  content still advances it. A metadata-only change does not advance it.
- `revisionId`: an immutable checkpoint identity scoped to the work. Retain
  the existing `(work_id, rev)` key. Do not treat the latest revision as the
  version of an unsnapshotted human edit.
- `contentHash`: computed by `documentContentHash` over the canonical saved
  body. Review will use this to recognize identical content after an undo.
  It does not replace the monotonic version precondition.

Keep `updatedAt` and the HTTP record version for whole-record concurrency
where needed. Name the distinction in the contracts: a timestamp/ETag is not
an implicit history id or a substitute for the agent's content precondition.
A combined title/body update must satisfy the applicable record and content
preconditions atomically.

Add version, hash, and current content author storage to the work row. Add
source content version, author, reason, and hash to revisions. Use a typed
author union for a person, agent, upstream provider, or unknown legacy author;
never invent attribution for old rows. Obtain new attribution from admitted
request context, not an arbitrary client label.

### Immutable snapshots and the existing previous-version UI

Define checkpoint reasons explicitly: baseline, checkpoint, agent, upstream,
review, and restore. A checkpoint stores exactly the body, author, version,
and hash that existed when it was captured.

- Preserve old revision rows as immutable legacy checkpoints. Backfill hashes
  and mark unknown authors honestly. Do not assign fabricated historical
  content versions; legacy source versions may be null.
- For a new work, save its initial baseline. For an existing work, first set
  `previousRevisionId` to the old newest revision, if any, then establish a
  baseline for its current body as part of migration or an atomic first use.
  Adding the baseline must not replace the existing comparison/revert target.
- Human autosave updates current content and version without a history row.
- Agent writes and upstream pulls capture the pre-write body if needed, then
  checkpoint the resulting body. The two checkpoints serve different purposes.
- Restore captures the displaced current body, writes the chosen snapshot as
  new current content, and adds a restore checkpoint. It never updates an old
  revision, decreases the content version, or deletes history.
- Keep an explicit `previousRevisionId` for the existing previous-version
  comparison/revert behavior. Point it at the displaced body for each agent,
  upstream, or restore operation. Do not compute it as `MAX(rev)` once the
  newest checkpoint represents the resulting body.

A user can still undo a restore with the existing revert action. Full history
UI remains in the parent plan. Provide domain history reads and checkpoint
operations now so review can later point to an exact version.

Tests: extend `tests/unit/work-version.test.ts`; add
`tests/unit/work-revisions.test.ts`. Cover two instances racing, human edits
without snapshots, metadata-only writes, equal-body writes, restore twice,
immutable old rows, scope isolation, legacy backfill, revert immediately after
migration, and rollback.

**Verify:** run both test files separately with `bun test <path>`; all pass.
Generate migrations with `bun run db:generate --name work-foundation` and
inspect both dialects. Check contracts and server types with the commands
in the verification section.

**Landed.** `work.ts` (`Work`), `work-rows.ts` (storage rows), and migrations
`sqlite/0021_work-foundation` and `postgres/0010_work-foundation`. The
migration sets `previous_revision_id`. Migration `work-legacy-removal`
(`sqlite/0022`, `postgres/0011`) then gives every work from before versions
its hashes and one `baseline` revision of its current body, eagerly, and makes
both `content_hash` columns NOT NULL. Legacy revisions keep their unknown
author and null source version; `previous_revision_id` is unchanged. SQLite
has no SHA-256, so its hashes are written by `hashLegacyWorks` in
`db/sqlite-migrations.ts`, in the migration's transaction before its SQL;
Postgres computes them in SQL. The SQLite rebuild of `works` recreates the
`works_fts` triggers and drops the unused `storage` column (Postgres drops it
too). No runtime path handles a missing hash. The RPC's agent author has no
session.

## 2. Route every content writer through Work

Move callers in `api-operations.ts`, `folio-handlers.ts`, `work-applier.ts`,
and `work-sync.ts` to the class. Include restore, import/create validation,
and provider pulls. Pull must carry the version seen **before** awaiting the
provider; it must not replace a human edit made while the pull was in flight.
Google pulls have a narrowly defined domain operation; do not expose a generic
public `skipReadOnly` boolean. Use the existing `parseDiagram` validation at
the domain boundary so RPC/outbox callers cannot bypass diagram validation.

For agents, add required `expected_content_version` to `update_work` and
return `content_version` with `read_work`. The same tool definition serves
Claude and Codex. Never reread the work to supply a new precondition on behalf
of stale model output. On mismatch, report a typed stale-write error and tell
the agent to read again. On success, return the new version. If the HTTP client
still fetches a fresh record ETag for metadata, the original content version
must also travel in the body and be checked in the same transaction.

Carry the version through `packages/contracts/src/outbox-types.ts`, foreign
work snapshots, and `work-applier.ts`. Missing versions must not be silently
replaced with current versions. Preserve receipt-based retry behavior: a
redelivery of an already committed operation must not create another revision
or fail against its own version advance. Verify the existing outbox receipt
boundary before adding any second receipt table.

Add a small `works.changed` event with work id, record version, and content
version. Emit after the enclosing database transaction commits, including
nested API transactions. Reuse `afterDatabaseCommit`; never notify on rollback.
Avoid sending full content on the general event stream. Existing session
`work_updated` events may still describe agent activity, but must not be the
only mechanism that updates an open work.

Wire the signal through `boot-server.ts`, `host-events.ts`, RPC topic
registration, and both transports. Add work-resource audience handling in
`sharing/event-audience.ts`: a guest sees only its shared work. Do not rely on
a default host-wide audience for a new event. API authorization remains at
request boundaries, with resource scope enforced again by the domain load.

Tests: add `tests/unit/work-write-paths.test.ts` for API/RPC/outbox/pull/restore
and agent stale-read behavior, plus `tests/unit/work-events.test.ts` for
commit/rollback and audience behavior. Use the existing work-version and
workspace API fixtures. Include repeated delivery and a provider pull that
completes after a human save without timing sleeps.

**Verify:** run these new files and `tests/unit/work-sync.test.ts` separately;
all pass. Run `bun run api:generate` only if the changed HTTP contract requires
regeneration, then `bun run api:check`.

**Landed.** Every content writer, a person's save included, names the
`expectedContentVersion` it read in the `Work` type; a writer that also holds
the record version names it too. `update_work` takes a required
`expected_content_version`, `read_work` returns `content_version`, and a
mismatch answers `Stale write: …` (one definition for Claude and Codex). The
HTTP PATCH body carries `expectedContentVersion`, required with `content` for
every writer, checked with If-Match in one transaction. `saveWork(id, updates,
base)` names the record and content version of the record the caller read;
client-core reads nothing at write time. `agentSaveWork` takes
the content version; `revertWork` takes the record version the reader saw
(the renderer holds no reliable content version until §5). The outbox `update`
op and the shipped work copy carry `expectedContentVersion`/`contentVersion`;
a stale or unversioned op dead-letters. A shipped work copy
(`TaskLinkedItemSnapshot` of kind `work`) always carries its type and version. The host outbox receipt
(`applied_ops`) now commits in the applier's transaction, so a redelivery never
re-runs a committed op; no second receipt table. The pull reads the version
before the provider call and writes through `Work.applyUpstream` (body, title,
and link in one transaction); the public `upstream` reason is gone.
`validateWorkContent` (`parseDiagram`) guards creation and every body change.
`works.changed` `{ workId, version, contentVersion }` is emitted from
`Work.mutate` and creation through `afterDatabaseCommit`, broadcast by the host
and the Solus API, and audienced by work resource. Left for §5: the
renderer does not consume `works.changed`, and delete emits no event.

## 3. Transfer complete history through Share

Change `WorkTransfer` from a single `previous` body to full immutable revision
records plus the current work's version/hash and previous-revision reference.
Keep organization assignment at the destination. Check every referenced
revision belongs to this work; preserve revision identities and authors.

Update export/import, the fingerprint, `sync/runner-protocol.ts`, and the
publication flow. Export a consistent database snapshot. Import current work,
history, annotations, and references atomically. Include all of these in the
fingerprint used to protect source deletion. Verify supplied hashes rather
than accepting a malformed history record because its outer fingerprint is
self-consistent. Same-transfer retries must be idempotent.

Do not truncate history to keep a message small. Check actual request limits;
if realistic histories exceed them, stop and specify a bounded transfer
protocol before shipping. Yjs state transfer is a later requirement, not a
reason to add an unused opaque payload now.

Extend `tests/unit/cloud-sharing.test.ts`: multiple revisions, restore,
authorship, previous-version behavior after import, retry, invalid revision
references, and source edits during transfer. Verify in a temporary database.

**Verify:** `bun test tests/unit/cloud-sharing.test.ts` passes; typechecks and
API generation checks pass after the transfer contract changes.

**Landed.** `WorkTransfer` is `{ work, previousRevisionId, revisions, annotations,
fingerprint }`: `work` keeps `contentVersion`, `contentHash`, and author;
`revisions` is every `WorkRevision` (body, `revisionId`, reason, source version,
author, hash, capture time), oldest first. Export runs in one transaction and
sends only hashes the source stores. The fingerprint is sha256 over the work (without organization), the
previous reference, all revisions, and the annotations. Import rechecks the
fingerprint, recomputes each hash, and requires each revision to name this work,
a unique ascending id, and a version the work had; the previous reference must
name one of them. It writes the work, the revisions under their source ids, and
the comments in one transaction. The same fingerprint again writes nothing. The
share claim and task links in `applyRunnerWork` stay outside that transaction,
as before; they are idempotent. Size: no body limit applies to `/runner/works`
(no Hono `bodyLimit`, none in the Fly proxy config). The limits are time: the
runner's 15 s request timeout and the server's 30 s `requestTimeout`. A history
of some megabytes fits in that time. There is no chunked protocol. A request that
times out is `unreachable`: the publication stays `sent`, the local copy stays,
and the next delivery cycle sends it again (a retry of an import that did commit
answers the stored work). If real histories approach the timeout, specify a
bounded transfer protocol before raising the limits.

## 4. Extract the document schema and remove display mutations

Create `packages/document-model/` for the schema, schema version, and markdown
parse/serialize functions. It must import no Svelte components, browser APIs,
Electron APIs, or workspace stores. Inspect existing custom blocks first:
`mermaidBlockExtension.ts`, `htmlBlockExtension.ts`,
`diagramEmbedExtension.ts`, `artifactEmbedExtension.ts`,
`frontMatterExtension.ts`, and `codeBlockView.ts`. Extract their schema and
markdown behavior; renderer modules extend those definitions with node views.
Use `components/editor/lib/front-matter.ts` as a DOM-free reference.

Have `DocumentEditor` and `DocumentShell` use one canonical schema list. Keep
shortcuts, table controls, highlighting, and node views in the renderer. The
host codec must build the same nodes, marks, and attributes without a DOM.
No second hand-maintained list. Keep the plain-text raw markdown editor
working as it does today; its later collaborative diff is a separate phase.

Move `planComment` highlights to decorations. Preserve the existing comment
commands, quote matching, active/resolved styles, selection behavior, and
thread identity. Use `external-comment-highlights.ts` as an example, without
merging local and external thread ownership. Map decorations through edits.
Refreshing comments must not change document JSON, markdown, or undo history.

Keep `asset://` in document image attributes. Resolve display URLs in an image
node view or equivalent presentation layer. Remove the document mutation and
reverse replacement map from `DocumentEditor`. Image copy/export must keep
stable references and resolve assets through the correct host when required.
Ensure a late URL resolution cannot update a destroyed or different image view.

Add `tests/unit/document-model.test.ts` and
`tests/unit/document-display-state.test.ts`. Use fixtures for front matter,
images, marks, lists, aligned tables, Mermaid, HTML, diagram/artifact embeds,
and escaped text. Test renderer/host schema equality, Node-only import,
round-trip stability, and semantic preservation. Fix the known table padding
issue within the codec. Do not rewrite stored works merely by opening them.
If supported content cannot round-trip without loss, report the failing
fixture before enabling that conversion for writes.

**Verify:** new tests plus `tests/unit/work-embed.test.ts`,
`tests/unit/raw-markdown-editor.test.ts`, and
`tests/unit/document-diagram-assets.test.ts` pass, each in its own invocation.
Check the new package and workspace UI types.

**Landed.** `@solus/document-model` exports `schema` (`DOCUMENT_SCHEMA_VERSION`,
`markdownExtensions`, `documentExtensions`), `markdown` (`createMarkdownParser`,
`parseDocumentMarkdown`, `serializeDocumentMarkdown`), `fences`, and the node
definitions (`blocks`, `front-matter`, `image`, `table`, `person-reference`).
The renderer builds its schema through `components/editor/lib/editor-schema.ts`,
which passes node views into the model's list; a view must replace a node of
the same name. The work schema includes `personReference`. `codeBlockView.ts`
keeps extending `CodeBlockLowlight`, whose schema and markdown equal the model's
code block (tested). Comment highlights are `comments/lib/comment-highlights.ts`
decorations, separate from the external plugin; the highlighted set is exactly
the comments the layer receives. Known limit: without a DOM, raw inline HTML in
markdown (not an ```` ```html ```` fence) is literal text on the host but HTML in
the editor. It is a `test.todo` in `document-model.test.ts`; do not use the host
codec for writes of such content.

## 5. Use one open-work state model on every host

Refactor `contexts/works/works.store.svelte.ts`,
`cloud-work-copy.store.svelte.ts`, and `components/work/WorkPane.svelte`.
Separate authoritative saved content from each mounted editor's unsaved draft.
Use one store-owned saved record per `(serverId, workId)` and reference-counted
subscriptions for open works. Multiple panes must share saved state while
retaining their own selection and draft state.

Replace the cloud-only polling copy and agent-only revision counter with a
common work-change path. On `works.changed`, coalesce in-flight reloads and
apply version guards. A clean editor accepts the new saved content. A dirty
editor retains its draft and reports a conflict. A successful local save
cannot mark a newer local edit clean. Equal-version events are harmless.

Subscribe before the initial read and guard responses against newer events.
On reconnect, reload authoritative state. Keep the current draft on network
failure. On delete or revoked access, stop the subscription and show the
unavailable state; do not silently delete an unsaved draft. On Share, release
the old-host subscription and acquire the destination host under the existing
work id. Do not add polling per pane or reload every work for one change.

Preserve provisional agent-created works and their generating state. A
session event can still open or discover a work, but receiving both a session
event and `works.changed` must not trigger duplicate remounts. Plain records
must be updated in place so one change does not invalidate unrelated works.

Extend `tests/unit/works-store-remote-update.test.ts` and replace the
cloud-specific assertions in `tests/unit/cloud-work-copy.test.ts` with shared
open-work tests. Add `tests/unit/work-open-state.test.ts` for two panes, two
hosts, event/read races, save/edit races, reconnect, access removal, Share,
and cleanup. Keep `tests/unit/work-pane-opening.test.ts` passing.

**Verify:** run these files separately; all pass. Run contracts, client-core,
and workspace UI typechecks. Confirm no remaining cloud-only record copy or
agent-only content refresh path in `WorkPane`.

**Landed.** `WorksStore` keeps two maps: `works`, the metadata listing (gallery
rows and provisional entries, no body), and `saved`, one host-read record per
work, changed only by `acceptSaved` (in place; an equal or older answer, or one
from a host that no longer owns the work, is ignored). `openWork(workId)`
returns a reference-counted lease on an `OpenWork`
(`contexts/works/open-work.svelte.ts`) that subscribes to `works.changed`,
`share.changed`, and phase changes on the owner host before its first read,
reads again on a newer change, on reconnect, and once more after a read that a
change interrupted, and marks the work unavailable on delete, 404, or 403.
Each pane holds a `WorkDraft` (`components/work/lib/work-draft.svelte.ts`):
a clean draft adopts a newer saved body through the shell's `content` prop
(the diagram calls `DiagramDocument.replace`, the document editor syncs its
value); a dirty one keeps its edits and reports a conflict; a save names the
draft's base record version, and a 412 is a conflict. After Share,
`markPublished` rebinds the open work to the service; a draft whose base has
the destination's content hash carries over. The session `work_updated` event
updates the listing only. `revertWork` takes the content version. A save
names the draft's base record and content version. Opening a work
(`openWorkModal`) does not read it; the pane's lease reads once it has
subscribed. Deleting a work through the API emits `works.changed` with
`deleted: true` to every reader who could open it: `announceWorkDeleted`
decides the audience inside the delete's transaction, before the grants are
removed (`HostEventPublisher.prepareBroadcast`), and sends it after commit.
Removed: `cloud-work-copy.store.svelte.ts` and its 30-second poll,
`agentRevisions`, the placeholder bodies with `contentVersion: 0`,
`loadWorkUpdatedAt`, and the record-version revert. A link that names only a
work id (a document reference, a transcript card, a task link) still resolves
on the default host until a listing or a host-addressed event places it.

## 6. Give diagram editing a DiagramDocument class

Create `components/diagram/lib/diagram-document.ts`. This is a client editing
model, distinct from the server `Work` persistence class. It owns diagram
content and semantic edits, with typed methods such as:

```ts
diagram.moveNode(viewPath, nodeId, position)
diagram.updateNode(viewPath, nodeId, changes)
diagram.removeNode(viewPath, nodeId)
diagram.updateEdge(viewPath, edgeId, changes)
diagram.undo()
diagram.redo()
```

Use the existing `DiagramDoc` and field types from
`packages/contracts/src/diagram-types.ts`. A view path identifies nested
detail; preserve the depth currently supported by the product. Avoid an
untyped patch dictionary or a new generic graph framework.

Move content mutation rules out of `DiagramShell`: node/edge add, update,
delete, move, resize, reconnect, grouping, layout application, and detail edits.
Reuse the existing geometry and conversion helpers. Removing a node removes
its affected edges and preserves existing group rules. A position is one
`{x, y}` value. A nested edit addresses its target node or edge; it must not
replace the whole detail document as the normal mutation primitive.

The model owns one canonical document. The flow canvas is a projection of it.
A canvas event becomes a command, then updates only affected projected nodes
or edges. Do not keep a separately mutable `rootDoc` and reconstruct content
from the current view for each save. Keep selection, hover, search, drawers,
viewport, focus, and navigation in view state. Keep transport and save-status
state in the editor/store layer, outside `DiagramDocument`.

Support grouped edits so a drag or multi-node action makes one undo step.
During a drag, keep temporary geometry local to the view and commit the final
position once. Preserve current single-editor undo with the existing history
implementation behind the model. No Yjs dependency is required here. During
live editing, replace that history implementation with origin-scoped Yjs
transactions and undo; do not run snapshot undo beside Yjs.

Make model snapshots read-only or detached so callers cannot bypass commands.
Expose the existing `{nodes, edges}` serialization format, including detail,
for save, export, and agent tools. Cleanly replace model content when an
accepted external save reloads a clean editor; clear obsolete local undo at
that boundary. Do not let navigation or projection create history entries.

Split the 3,000-line shell along the actual boundaries exposed by this work:
document commands in the model, canvas interaction logic in a colocated
controller, and independent controls in components. The shell must be under
1,000 lines when complete. Flag remaining files over 600 lines. Do not meet
the limit by moving the entire shell into one large controller.

Add `tests/unit/diagram-document.test.ts`: field preservation, connected-edge
cleanup, group operations, nested detail edits, one-step drag undo, redo,
external replacement, detached snapshots, and serialization. Preserve
`diagram-history`, `diagram-editing-geometry`, `diagram-flow-builders`,
`diagram-page-layout`, and `diagram-inspector-model` tests. Add a focused
shell/controller integration test proving that user actions call the model
and a save includes edits made in a nested view.

**Verify:** run each named test file separately with `bun test`; all pass.
`wc -l packages/workspace-ui/src/components/diagram/DiagramShell.svelte` is
below 1,000. Workspace UI types and changed-file lint pass.

## Verification and completion

The initial audit ran `bun test tests/unit/work-version.test.ts`: two tests
passed. That is a narrow baseline, not proof of these proposed changes.
All new test filenames above are deliverables, not existing test coverage.

Commands verified to exist in repository scripts:

| Purpose | Command | Expected result |
|---|---|---|
| Focused behavior | `bun test tests/unit/<named-file>.test.ts` | All assertions pass |
| Contracts and client core | `bun run check` | Exit 0 |
| Server types | `bun run --cwd packages/server check` | Exit 0 |
| Workspace UI TypeScript | `bun run --cwd packages/workspace-ui check` | Exit 0 |
| HTTP contract generation check | `bun run api:check` | No generated drift |
| Database generation, when schema changes | `bun run db:generate --name work-foundation` | Reviewed migration for each engine |
| Changed-source lint | `bunx oxlint <changed-source-paths>` | No new findings |
| Diff hygiene | `git diff --check` | No whitespace errors |

Package TypeScript checks do not replace Svelte/browser verification. Run
existing module-boundary tests (`tests/unit/server-module-boundaries.test.ts`)
after introducing shared modules. If a baseline check fails due to unrelated
work, record the exact failure and distinguish it from a new failure; do not
change unrelated files to make the command green.

Before completion, verify these behaviors across desktop-local IPC and
remote WebSocket/HTTP paths. The shared responsive UI covers desktop, web,
and mobile; the refactor introduces no new platform exception. Both Claude
and Codex must receive the same work-tool version contract. Include light and
dark comment/image presentation, keyboard diagram commands, focus after
editing, and phone read-only diagram behavior in an integrated visual pass.
Do not start a server or perform that pass without the user's agreement.
Report unexercised surfaces explicitly if that pass has not run.

Done means:

- All content writers use `Work` and carry the required original precondition.
- History is immutable; restore and Share preserve checkpoint identity.
- Committed writes notify authorized work readers, independent of sessions.
- Local and cloud panes use the same saved-state and conflict rules.
- The shared schema loads without renderer dependencies.
- Comment/image display work leaves content and undo unchanged.
- Diagram content edits go through `DiagramDocument`; the shell no longer
  owns a second mutable document or whole-document mutation/undo path.
- The named regression tests and applicable checks pass, with baseline
  failures and any unperformed visual checks reported.
- The parent plan and this status table describe what actually landed.

## Later live-editing requirements

Keep these contracts explicit in the parent plan, but do not implement them
as unused foundation machinery:

- Review decisions name the exact checkpoint the reviewer saw. If they review
  a newer current body, create that checkpoint against their content version
  before recording the decision. An old decision may be stored as stale; it
  must never be silently attached to a newer body.
- A live push confirmation means its state and retry receipt survive a host
  restart. Markdown projection can be debounced; durable acceptance cannot.
  Agent reads, review checkpoints, and exports must see a projection consistent
  with the version they return, even before the debounce fires.
- Agent locks serialize writes at the owner. Pending/offline updates remain on
  the client; a temporary locked response is retryable, not a reason to erase
  the update or reset its Y.Doc. After unlock, reconcile and merge. This cannot
  promise an agent has seen edits that have not yet reached the host.
- Raw markdown editing needs a structural diff into the shared document or an
  explicitly approved restriction during live editing. The current full
  `setContent` path must not silently become a collaborative write.
- Preserve CRDT identity during storage compaction and Share. Do not rebuild a
  new Y.Doc from markdown and expect old offline updates to retain their meaning.
- History contains checkpoints, not every discarded concurrent field value.
  Do not promise recovery of every lost concurrent edit without a mechanism
  that actually stores it.

## Conditions that require a plan correction

Stop the affected step and report evidence if the current code has a different
owner/version model; an existing writer cannot carry its read precondition;
a supported document cannot round-trip; complete history exceeds transport
limits; or preserving current diagram behavior requires a new product rule.
Continue independent steps where possible. Do not silently weaken the version,
history, or single-owner rules to finish a refactor.
