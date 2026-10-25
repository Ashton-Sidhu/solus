# Custom roles and closed actions

Status: proposed 2026-10-25. Changes `permissions.md` (§2, §3, §5) and
`host-sharing.md` (§2, §4, §6). Read both first.

## 0. Why

Three facts from the current code:

1. **An editor link gives the holder commands on the host.** A guest prompt runs
   in `supervised` mode, but `respondPermission` needs only `session.drive`,
   and an editor link holds it. The `guestTurn` tag
   (`execution/sessions/input-requests.ts:104`) changes only the card label. So
   a person with the link can prompt, approve their own `Bash` call, and run
   commands on the owner's machine.
2. **`drive` is too coarse.** It covers prompts, approvals, attachments, the
   queue, devices, `takeScreenshot`, `attachFilePaths`, and `pasteImage`. An
   owner cannot give "prompt but not approve". The desktop handlers in
   `apps/desktop/src/main/server/handlers/file-handlers.ts` act on the host's
   own screen and disk, but any principal with `drive` on the session it names
   can call them over the WebSocket. `attachFilePaths` reads any image under 2
   MB on the host and returns the size of any path.
3. **New methods are open.** `PERMISSION_OF_METHOD` and
   `RESOURCE_VERB_OF_METHOD` are `Partial<Record<RpcMethod, …>>`. A method in
   neither table needs `host.use`, which every person holds. A method put under
   a verb reaches every role and every link that holds the verb, whether or not
   someone thought about guests.

We have no users, so we change the model, not only the two problems.

## 1. Decisions

- **D1. The owner decides what a link may do.** Every action, approvals
  included, is a choice with a safe default (§4). There is no fixed limit that
  the owner cannot raise. A risky action shows a warning in the dialog.
- **D2. A role is a set of actions.** `viewer`, `commenter`, `editor`, and
  `owner` become named presets. `custom` is a role whose actions the sharer
  picks. Links and named people use the same model.
- **D3. Resource actions are dotted paths with the prefix rule.** The rule that
  `host.*` permissions already use (`permissionsAllow`) also applies to
  resource actions. A role that holds `session.drive` covers every child,
  including children we add later.
- **D4. The action table is closed.** One table names the action of every RPC
  method, and it must list every method (`satisfies Record<RpcMethod, Action>`).
  There is no `host.use` fallback. A new method does not compile until someone
  names its action.
- **D5. Host-local methods need `host.local.window`.** `takeScreenshot`,
  `attachFiles`, `attachFilePaths`, and `pasteImage` act on the host machine.
  No session role and no link opens them.

### Conflicts with earlier decisions

- `permissions.md` (status line) removed "the guest allowlist" in favor of one
  table for every principal. This plan keeps one table. It does not add a guest
  list. Guests are closed because the table is closed and a link's role is a
  set of actions, not because of a second list.
- `permissions.md` §5 says "Add a method. Nothing, unless a principal must hold
  it apart from `host.use`." D4 reverses this on purpose: adding a method needs
  one row. That row is where the author decides who may call it.
- `permissions.md` §1 uses **scope** for the bound on a permission (the
  checkout bound of `assertPathInScope`). So this plan does not call a link's
  actions its "scope". It is the link's **role**.

## 2. Vocabulary

- **action** — unchanged from `permissions.md` §1: one thing a person can do,
  as a dotted path. A permission (`host.*`) or a resource action
  (`session.*`, `work.*`, …).
- **resource action** — `<kind>.<verb>[.<leaf>]` on one resource. Held through
  the resource role. Replaces the flat resource verb.
- **role** — the set of resource actions an ACL entry gives. A **preset** has a
  name (`viewer`, `commenter`, `editor`, `owner`). A **custom role** lists its
  actions.
- **capability** — unchanged: what the host can do at all (transcribe,
  screenshot). Not a permission.
- **suggestion** — a guest's proposed message and its files, which a person
  with `session.drive.prompt` sends or dismisses.

Do not say "scope", "grant", "allowlist", or "capability" for a link's actions.

## 3. The action tree

The session subtree. Works and tasks keep their flat verbs as single-leaf
paths until a second leaf is needed.

```
session.read.transcript       transcript, tool output, plans, cards, watchSession
session.read.diffs            diff, diffFileContents, diffStats, listTurnSnapshots
session.read.files            readProjectFile, listProjectFiles, searchFiles, … inside the checkout
session.comment               plan and transcript comments
session.drive.propose         guestSuggest (new)
session.drive.prompt          prompt, retry, compactSession, stopSession, the queue, presenceSetComposing
session.drive.attach          attachUpload, attachUploadToken
session.drive.approve         respondPermission, respondQuestion, decideSessionPlan, acceptPlan, rateLimitDecision
session.drive.devices         deviceOpen, deviceClose
session.drive.apps            mcpAppToolInfo, mcpAppCallTool, mcpAppReadResource
session.edit                  title, branch, goal, plan files, task links
session.share                 shareSet, shareSetLink
session.own                   shareTransfer, export
```

Notes:

- Every method names a leaf, never a parent. A preset holds parents
  (`session.read`, `session.drive`), so it covers every leaf under them,
  including new ones. A custom role holds only leaves, so a new leaf is off
  for it until the sharer turns it on.
- `session.read.files` moves the files and git reads of a guest from host
  permissions (`host.files.read`, `host.git.read` in `GUEST_PERMISSIONS`) to the
  session. The `assertPathInScope` bound stays.
- The step 2 audit sets the final list of methods for each leaf. The table
  above is the starting point.

## 4. Presets and link defaults

```ts
// packages/contracts/src/permissions.ts
export const ROLE_ACTIONS = {
  none: [],
  viewer: ['session.read', 'work.read', 'task.read'],
  commenter: [...viewer, 'session.comment', 'work.comment'],
  editor: [...commenter, 'session.drive', 'session.edit', 'session.share', 'work.edit', 'work.share', …],
  owner: [...editor, 'session.own', 'work.own', 'task.own'],
} as const satisfies Record<PresetRole, readonly ResourceAction[]>
```

The presets hold exactly what the verbs hold now. Signed-in members see no
change.

A new link gets a custom role with these defaults:

| Row in the dialog | Action | Default |
| --- | --- | --- |
| Watch the session | `session.read.transcript` | on, locked |
| See diffs | `session.read.diffs` | on |
| See files | `session.read.files` | off |
| Comment | `session.comment` | on |
| Suggest messages | `session.drive.propose` | on |
| Prompt directly | `session.drive.prompt` | off |
| Attach files | `session.drive.attach` | on (needs propose or prompt) |
| Approve tools and answer questions | `session.drive.approve` | off, with the warning "This lets the guest run commands on this computer" |
| Use devices | `session.drive.devices` | off |
| Expires | link row | 24 h (1 h · 24 h · 7 d · never) |

The rows, labels, warnings, defaults, and rules between rows live in one
registry beside `ROLE_ACTIONS`:

```ts
export const SHAREABLE_ACTIONS = {
  'session.read.diffs': { label: 'See diffs', linkDefault: true },
  'session.drive.approve': {
    label: 'Approve tools and answer questions', linkDefault: false, requires: ['session.drive.prompt'],
    warning: 'This lets the guest run commands on this computer',
  },
  …
} as const satisfies Partial<Record<ResourceAction, ShareableAction>>
```

The share dialog (desktop and web) and the mobile share sheet render their rows
from this registry. Adding a row needs no client code. The server applies
`requires` when it writes a role, so a client cannot store a role that breaks
the rules.

Settings holds the owner's own link defaults. They start from `linkDefault`.

## 5. Storage

- `acl_entry.role` keeps the preset name, or `custom`.
- A new column `acl_entry.actions` (JSON text, nullable) holds the action list
  of a custom role. It is null for a preset.
- A new column `acl_entry.expires_at` (bigint, nullable) holds a link's expiry.
- A preset's actions come from `ROLE_ACTIONS` when the row is read, so a new
  child under a parent that a preset holds reaches that preset at once.
- A custom role holds only the leaves it lists. A new leaf is off for every
  existing custom role, so adding a capability never widens a link.
- An unknown action in a stored row is ignored on read and logged
  (`acl_actions_unknown`). This covers a host on an older build that reads a
  row mirrored from a newer one.
- The mirror (`ShareManager.mirroredRows`) carries both columns. The Solus API
  applies them in `applyMirroredRows`.

## 6. The gate

```ts
// contracts
export const ACTION_OF_METHOD = { … } as const satisfies Record<RpcMethod, Action>
```

- `ACTION_OF_METHOD` replaces `PERMISSION_OF_METHOD` and
  `RESOURCE_VERB_OF_METHOD`. Each method names a permission or a resource
  action. Each method that now falls back to `host.use` is written as
  `host.use`, so members see no change.
- `RESOURCE_LOCATORS` stays. The test that the two tables name the same
  resource methods stays.
- `roleOf` returns the held actions of the principal on the resource: the
  union of the actions of every ACL entry that applies (person, team,
  organization, link). The union replaces the role rank.
- `authorize(principal, action, resource)` becomes
  `permissionsAllow(heldActions, action)`, the same prefix check as for host
  permissions. A guest call also checks the link's expiry. There is still one
  decision, and the RPC gate and `requireResource` both call it.
- `holdOrganizationAtLink` becomes: the organization entry holds at least the
  union of its own actions and the link's actions.
- `opensAs` (`share-link-resolver.ts`): a signed-in member opens a link as
  themselves when their actions include every action of the link.
- `GUEST_PERMISSIONS` becomes `host.connect`, `host.agents.read`, and
  `host.models.read`. The rest of what a guest may do comes from the link's
  role on its one resource.

### Events

- Each host event type names the resource action that its audience needs, in
  a table that must list every type (`satisfies Record<HostEvent['type'], …>`).
  The default for a resource event is `<kind>.read`. Diff events need
  `session.read.diffs`.
- `eventVisibleTo` and the room admission (`publishToRoom`) read that table.
  The room admission keeps the held actions of each member, not only "may
  open", and checks again on a share change as it does now
  (`forgetRoomAdmissions`).

### HTTP routes

- The signed-capability routes (`/api/assets/:token`, `/api/uploads/:token`,
  `/api/device-hub/:token/:route`) are already closed: a token is minted over
  the RPC gate. Each one names the action of the RPC that mints it.
- `/upload`, `/voice/transcribe`, `/artifact`, `/auth/*`, `/pair/*`, and the
  OAuth callbacks need a review in step 2: write the principal and action each
  one accepts, and put the list in one table with a test that a route not in
  the table returns 404.

## 7. Suggestions

- New RPC `guestSuggest(ctx, { text, attachments })`, action
  `session.drive.propose`. The text has a limit of 4000 characters. A link has
  at most 3 waiting suggestions.
- A suggestion is a queued item with the state `waiting`. It shows to people
  with `session.drive.prompt` as a card with **Send** and **Dismiss**. When
  someone sends it, it runs as a normal turn from the sender, with the text
  prefixed `Message from guest <name>, sent by <sender>:`. Because of the
  prefix, a suggestion can never start a slash command.
- A guest with `session.drive.prompt` sends direct turns. Its turns still run
  in `supervised` mode. The question of who may approve is now only
  `session.drive.approve`, so the `guestTurn` card label stays as information.
- Reverse states: the guest sees each suggestion's state (waiting, sent, not
  sent). The guest can withdraw a waiting one. Closing or replacing the link
  removes the waiting suggestions and their files.

## 8. Guest attachments

- `attachUpload` and `attachUploadToken` need `session.drive.attach`. A guest's
  files go into the bucket of its suggestion or turn. The existing limits stay
  (10 MB a file, 8 a session).
- When it receives an image, the server checks the first bytes against the
  declared type (PNG, JPEG, GIF, WebP). It refuses SVG from a guest.
- Stored files are served with `X-Content-Type-Options: nosniff`, and a file
  that is not an image is served as `application/octet-stream` with
  `Content-Security-Policy: default-src 'none'; sandbox`.
- A dismissed suggestion removes its files.

## 9. Links

- Expiry: `acl_entry.expires_at`. `authorize` refuses an expired link, and the
  share manager disconnects its guests (`share-link-revoked`) when it expires.
- A link is refused on a plain `http:` origin that is not Tailscale. The dialog
  says why and offers to link the computer.
- A change to a link's role reaches connected guests at once, as a role change
  does now.

## 10. Clients

- `Host.me.may(action, resource)` reads the held actions that the resource
  carries in place of `role`. `resourceAllows` on mobile does the same. The
  resource answers carry `actions` next to `role`.
- Every control asks for its leaf: the composer asks
  `session.drive.prompt` (or `propose` for the suggest composer), the
  permission card asks `session.drive.approve`, the attach button asks
  `session.drive.attach`, the diff panel asks `session.read.diffs`.
- `ShareDialog.svelte`: the quick choices stay (view, comment, edit) and
  **Custom** opens the rows from `SHAREABLE_ACTIONS`. The same rows apply to a
  named person.
- Mobile: the suggestion card with Send and Dismiss, and the link role and
  expiry in a share sheet. Mobile still does not open share links
  (`instant-share-open.md` §6). That stays out of scope.
- Desktop and web: the guest composer becomes "Suggest a message" when the
  guest holds only `propose`.

## 11. Steps

1. **Host-local methods (D5).** Move `takeScreenshot`, `attachFiles`,
   `attachFilePaths`, and `pasteImage` to `host.local.window` in
   `PERMISSION_OF_METHOD`, and remove them from `RESOURCE_VERB_OF_METHOD` and
   `RESOURCE_LOCATORS`. First check that the desktop app, when it is connected
   to a remote host, does not call `attachFiles` on that host. If it does, that
   path changes to `attachUpload`. Tests: a guest and a remote member are
   refused all four; the local owner passes.
2. **Closed action table (D4).** Merge the two tables into `ACTION_OF_METHOD`,
   write every `host.use` method, and add the event table and the HTTP route
   table. No behavior change; the tests prove the tables are complete.
3. **Dotted resource actions and presets (D2, D3).** `ROLE_ACTIONS`, `roleOf`
   as a union, `authorize` with the prefix rule, `opensAs`. No behavior change
   for presets.
4. **Custom roles on links.** The columns, the mirror, `SHAREABLE_ACTIONS`, the
   dialog rows, link defaults in Settings, expiry, the `http:` refusal.
   Existing editor links become custom roles with the link defaults: they lose
   `prompt` and `approve`.
5. **Suggestions and guest attachments** (§7, §8), with the mobile card.
6. **Docs and the Lab.** Update `permissions.md`, `host-sharing.md`, and
   `docs/` user pages. Lab scenarios: a link with the default role cannot
   prompt, approve, or read files; a link with `approve` can; changing the
   role reaches a connected guest; an expired link disconnects.

## 12. Proofs

- `ACTION_OF_METHOD`, the event table, and the route table are complete (the
  compiler and one test).
- Every leaf in `SHAREABLE_ACTIONS` names at least one method.
- A link with the default role is refused every method whose action is not in
  that role. The test goes through `ACTION_OF_METHOD`, so a new method is
  covered without a new test.
- Each preset holds the same methods as before (a snapshot of the old verb
  answers against the new action answers).
- A custom role stored before a new leaf was added does not hold that leaf.
- A guest is refused `respondPermission` unless its link holds
  `session.drive.approve`.

## 13. Open questions

None open.

Decided 2026-10-25: a custom role goes to a link, or to a person, a team, or
the organization inside the sharer's organization. Email invites to people
outside the organization (`host-sharing.md` §6, §8 step 6) are out of scope,
because sharing a session with another organization is out of scope. A person
outside the organization uses a link. When invites come later, they need a
verified email, a principal kind for people outside the organization (not
`org-member`, which holds `PERSON_PERMISSIONS`), and the host as the one writer
of the row.

Decided 2026-10-25: works and tasks keep their flat verbs (`work.read`,
`work.comment`, `work.edit`, …). A custom role applies to sessions only, and
the share dialog of a work offers only the presets.
