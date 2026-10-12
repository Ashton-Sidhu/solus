# Permissions — one table for the gate and the controls

Status: done 2026-10-09. Replaces the method classes of
`admission/access-policy.ts` (`local-only`, `host-admin`, `host-wide`,
`resource`, `system-only`) and the guest allowlist, and the client's guesses
(`canDriveSession` on its own, sign-in checks standing in for permission).

Where it lives:

- Contracts: `packages/contracts/src/permissions.ts` — the host-action table
  (`HOST_ACTION_OF_METHOD`, default `host.use`), the resource verbs
  (`RESOURCE_VERB_OF_METHOD`), the role table (`ROLE_VERBS`), and `grantsAllow`.
  `ConnectionsServerInfo.grants` carries a connection's grants.
- Server: `admission/access-policy.ts` — `grantsFor(principal)`, the one gate
  `assertRpcAccess`, and `RESOURCE_LOCATORS` (where a resource id sits in a
  call). `admission/scope.ts` — the bound on a guest's grants.
- Clients: `Host.me` (`contexts/hosts/host-standing.svelte.ts`) answers
  `may(action)` and `may(verb, resource)`; `contexts/sharing/resource-roles.ts`
  reads the share role. Mobile reads the same `grants` from its `HostFacts`.

## 1. Vocabulary

- **action** — one thing a person can do, as a dotted path named for the
  person, never for the wire: `host.git.write`, `session.drive`.
- **grant** — a prefix a connection holds on the host: `host.git` covers
  `host.git.read`, `host.git.write`, and anything added under it later; `host`
  covers everything. Deny is absence; there is no deny list.
- **host action** — `host.*`, held on the host as a whole. Computed once per
  connection (`grantsFor`) and sent with the server info.
- **resource verb** — `read`, `comment`, `drive`, `edit`, `share`, `own` on one
  session, work, or task. Held through the share role, never granted on the
  host. `drive` is a session's turns and cards; `edit` is its record (title,
  links, goal, plans) or a work's or task's body.
- **scope** — the bound on a grant. Only a guest has one today: `host.git.read`
  and `host.files.read` reach the shared session's checkout and nothing else
  (`assertPathInScope`).
  Scope becomes data on the grant the day a second bounded case appears.
- **capability** — what the host can do at all (transcribe, screenshot).
  Separate from permission; both feed a control's disabled state.
- **standing** — `host.me`: this client on this host. "May I, here."

Do not say "class", "allowlist", "role" for a host action, or "permission" for
a capability.

## 2. The tables

1. `HOST_ACTION_OF_METHOD`: a method is listed only when a principal must hold
   it apart from `host.use`. Leaves today: `host.local.window`,
   `host.local.reach`, `host.admin`, `host.admin.connections`, `host.system`,
   `host.connect`, `host.agents.read`, `host.models.read`, `host.sessions.read`,
   `host.sessions.start`, `host.projects.read`, `host.git.read`,
   `host.git.write`, `host.files.read`, `host.files.write`, `host.terminal`,
   `host.usage.read`, and `host.use` for the rest.
2. `RESOURCE_VERB_OF_METHOD`: every method that names a session, work, or task
   and the verb it needs. The server pairs it with a locator; a test asserts
   the two tables name the same methods.
3. `ROLE_VERBS`: viewer reads; commenter also comments; editor also drives,
   edits, and shares; owner also owns.
4. `grantsFor(principal)`: system `['host']`; runner `['host.system']`; guest
   `GUEST_HOST_ACTIONS` (connect, agents.read, models.read, sessions.read,
   git.read, files.read); local owner `host.local` (or `host.local.window` on a managed
   host), `host.admin`, and the person set; remote owner the same without
   `host.local`; org member the person set, plus `host.admin` where
   `isHostAdmin`, else `host.admin.connections` on the workspace service.

## 3. The gate

`assertRpcAccess(method, principal, args)`:

- A managed host refuses `host.local.reach` whoever calls, the host included.
- A host method passes when the principal's grants cover its action.
- A resource method locates the resource. One that names nothing is `host.use`
  for a member and refused for a guest. The host's owner passes without a
  read. A host admin passes `shareTransfer`, and the share manager decides.
  Otherwise the share role must hold the verb.

Nothing else decides access.

## 4. The clients

- `host.me.grants` is the host's answer, or `['host']` until it answers, so an
  owner's controls never flicker on.
- `host.me.may('host.git.write')` gates git actions, branch switching, init,
  and publish; `host.files.read` the Files row and `host.files.write` the
  files pane's new, rename, delete, and edits; `host.terminal` the terminal;
  `host.use` the browser and devices; `host.sessions.start` New session; `host.projects.read` Add
  project; `host.usage.read` the usage meters.
- `host.me.may('drive', { kind: 'session', id })` is what every composer and
  card asks; `canDriveSession` is that question by name.
- A listing a principal may not read is not asked for. The stores already
  keep the last answer on a refused read.

## 5. Changing it

- **Split an action.** Change the method's row to the finer leaf and the
  control's `may` call. Every grant of the parent keeps working.
- **Add a principal kind.** One branch in `grantsFor`.
- **Add a method.** Nothing, unless a principal must hold it apart from
  `host.use`: then one row.
- **Add a scope.** Make the grant `{ action, within }`; `grantsAllow` and the
  tables do not change.

## 6. Proofs

`tests/unit/access-policy.test.ts` (the tables are exhaustive and agree; a
grant is a prefix; each principal kind's standing), `tests/unit/resource-roles.test.ts`
(the client's verb answers match `ROLE_VERBS`), `tests/unit/host-standing.test.ts`
(the owner's standing until the host answers, then the host's).
