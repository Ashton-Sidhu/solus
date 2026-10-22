# Permissions — one table for the gate and the controls

Status: done 2026-10-09; names changed to the standard terms on 2026-10-14
(`access-model.md` step 6). Replaces the method classes of
`admission/access-policy.ts` (`local-only`, `host-admin`, `host-wide`,
`resource`, `system-only`) and the guest allowlist, and the client's guesses
(`canDriveSession` on its own, sign-in checks standing in for permission).

Where it lives:

- Contracts: `packages/contracts/src/permissions.ts` — the permission table
  (`PERMISSION_OF_METHOD`, default `host.use`), the resource verbs
  (`RESOURCE_VERB_OF_METHOD`), the role table (`ROLE_VERBS`),
  `permissionsAllow`, and `resourceAllows`. `ConnectionsServerInfo.permissions`
  carries a connection's permissions.
- Server: `admission/access-policy.ts` — `permissionsFor(principal)`,
  `authorize(principal, action, resource)`, the one decision, and
  `RESOURCE_LOCATORS` (where a resource id sits in a call). The RPC gate
  `assertRpcAccess` and the Solus API's `requireResource`
  (`data/workspace/context.ts`) both call `authorize`. `data/sessions/guest-path-scope.ts` —
  the bound on a guest's permissions.
- Clients: `Host.me` (`contexts/hosts/host-standing.svelte.ts`) answers
  `may(permission)` and `may(verb, resource)`; the resource verb reads the
  `role` the resource carries (`access-model.md` §2.7), and
  `contexts/sharing/resource-roles.ts` keeps the roles of resources a control
  names by id. Mobile reads the same `role` with `resourceAllows`.

## 1. Vocabulary

- **action** — one thing a person can do, as a dotted path named for the
  person, never for the wire: `host.git.write`, `session.drive`. A permission
  or a resource verb.
- **permission** — `host.*`, held on the host as a whole and given by the host
  role. Computed once per connection (`permissionsFor`) and sent with the
  server info. A held permission is a prefix: `host.git` covers
  `host.git.read`, `host.git.write`, and anything added under it later; `host`
  covers everything. Deny is absence; there is no deny list.
- **resource verb** — `read`, `comment`, `drive`, `edit`, `share`, `own` on one
  resource: a session, work, task, automation, project, or notification. Held through the resource role `roleOf` gives
  (`access-model.md` §2.3), never held on the host. `drive` is a session's turns and cards; `edit` is its record (title,
  links, goal, plans) or a work's or task's body.
- **scope** — the bound on a permission. Only a guest has one today: `host.git.read`
  and `host.files.read` reach the shared session's checkout and nothing else
  (`assertPathInScope`).
  Scope becomes data on the permission the day a second bounded case appears.
- **capability** — what the host can do at all (transcribe, screenshot).
  Separate from permission; both feed a control's disabled state.
- **standing** — `host.me`: this client on this host. "May I, here."

Do not say "class", "allowlist", "grant" or "host action" for a permission,
"role" for a permission, or "permission" for a capability.

## 2. The tables

1. `PERMISSION_OF_METHOD`: a method is listed only when a principal must hold
   it apart from `host.use`. Leaves today: `host.local.window`,
   `host.local.reach`, `host.admin`, `host.admin.connections`, `host.system`,
   `host.connect`, `host.agents.read`, `host.models.read`, `host.sessions.read`,
   `host.sessions.start`, `host.projects.read`, `host.git.read`,
   `host.git.write`, `host.files.read`, `host.files.write`, `host.terminal`,
   `host.usage.read`, and `host.use` for the rest.
2. `RESOURCE_VERB_OF_METHOD`: every method that names a resource and the verb
   it needs. The server pairs it with a locator; a test asserts the two tables
   name the same methods. Since `access-model.md` step 5:
   - automations: `automationRead`, `automationListRuns`, `automationReadRun`
     `read`; `automationUpdate`, `automationSetEnabled`, `automationDelete`
     `edit`; `automationRun`, `automationCancel` `drive`. `automationList`,
     `automationRecentRuns`, and `automationCreate` stay `host.use`; a list
     holds only what `visibleTo` gives the caller (D4).
   - projects: `workspaceProjectUpdate`, `workspaceProjectRemove` `edit`.
     `workspaceProjectList` stays `host.use`: every member lists the
     organization's directory (`access-model.md` §2.3.1).
   - notifications: `notificationsSetRead`, `notificationsSetArchived` `edit`;
     only the recipient, the owner, holds it.
   - Insights reads (`metricsQuery`, `metricsTurnPage`,
     `metricsTurnListingSummary`, `metricsDistinctValues`, `metricsTurnTrace`)
     stay `host.use` and read through `visibleInsights` (D2).
     `metricsRunSql` is `host.admin`.
   - the `pr*` mutations are `host.git.write`; the handler also asks for
     `session.edit` on one of the sessions that link the pull request
     (`writePullRequest`).
3. `ROLE_VERBS`: viewer reads; commenter also comments; editor also drives,
   edits, and shares; owner also owns.
4. `permissionsFor(principal)`: system `['host']`; runner `['host.system']`; guest
   `GUEST_PERMISSIONS` (connect, agents.read, models.read, sessions.read,
   git.read, files.read); local owner `host.local` (or `host.local.window` on a managed
   host), `host.admin`, and the person set; remote owner the same without
   `host.local`; org member the person set, plus `host.admin` where
   `isHostAdmin`, else `host.admin.connections` on the workspace service.

## 3. The gate

`authorize(principal, action, resource)` is the one decision; it answers null
or a refusal:

- A managed host refuses `host.local.reach` whoever calls, the host included.
- The host itself passes.
- A permission passes when the principal's permissions cover it.
- A resource verb with no resource (a draft with no session yet) is `host.use`
  for a member and refused for a guest and a runner. Otherwise the resource
  role `roleOf` gives must hold the verb (`access-model.md` §2.3): the host's
  owner is an administrator, an `editor` of what is not theirs, and passes
  without a read only before the share manager exists (the desktop's
  in-process start).

The two doors call it:

- `assertRpcAccess(method, principal, args)` names the method's permission, or
  its verb and the resource `RESOURCE_LOCATORS` finds. A host admin passes
  `shareTransfer` first, and the share manager decides (plan 004 item 10).
- The Solus API's `requireResource(resources, context, resource, verb)` turns a
  refusal into 404. Its token scopes (`requireScope`) stay a separate upper
  bound on what a token may do.

Nothing else decides access.

## 4. The clients

- `host.me.permissions` is the host's answer, or `['host']` until it answers, so an
  owner's controls never flicker on.
- `host.me.may('host.git.write')` gates git actions, branch switching, init,
  and publish; `host.files.read` the Files row and `host.files.write` the
  files pane's new, rename, delete, and edits; `host.terminal` the terminal;
  `host.use` the browser and devices; `host.sessions.start` New session; `host.projects.read` Add
  project; `host.usage.read` the usage meters.
- `host.me.may('drive', { kind: 'session', id })` is what every composer and
  card asks; `canDriveSession` is that question by name. The session list
  keeps the `role` of each session it lists; a session it does not list asks
  for its share list once.
- `host.me.may('edit', project)`, `may('edit' | 'drive', automation)`, and
  `may('edit', integration)` read the `role` on the record: rename and remove
  of a project, edit, pause, star, delete, and run of an automation, and
  rename, remove, and tools of an MCP server are off, with the reason, when
  the role does not allow them. Share is not offered for a kind that has no
  ACL entries: an automation, a project, an integration, a notification, or an
  insight.
- A listing a principal may not read is not asked for. The stores already
  keep the last answer on a refused read.

## 5. Changing it

- **Split a permission.** Change the method's row to the finer leaf and the
  control's `may` call. Every holder of the parent keeps it.
- **Add a host role.** One branch in `permissionsFor`.
- **Add a method.** Nothing, unless a principal must hold it apart from
  `host.use`: then one row.
- **Add a scope.** Make the permission `{ action, within }`; `permissionsAllow`
  and the tables do not change.

## 6. Proofs

`tests/unit/access-policy.test.ts` (the tables are exhaustive and agree; a
held permission is a prefix; each principal kind's standing; the RPC gate
refuses exactly what `authorize` refuses), `tests/unit/resource-roles.test.ts`
(the client's verb answers match `ROLE_VERBS`; a listed role answers without a
share list), `tests/unit/host-standing.test.ts` (the owner's standing until the
host answers, then the host's; a resource verb reads the `role` it carries).
