# 035 Cloud machine tools

Status: PLAN (2026-11-26). Decisions 1–9 are signed off by the maintainer
(2026-11-26). §11 (sharing) needs sign-off. No code is written. The work waits on
the in-flight plan 034 changes (§12).

## 1. Problem

A signed-in person can create, change, restart, and delete the cloud machines
of their organization from Settings → Machines and from the console. An agent
cannot. When the person says "make me a cloud machine with Docker on it", the
agent must send them to Settings.

The host cannot make these calls for the person today. Every lifecycle route of
Solus Cloud (`POST /v1/hosts`, `start`, `stop`, `restart`, `spec`, `machine`, and
`POST /v1/enrollment-tickets`) uses `requireAccountSession`. That check refuses
every token with an `act` claim (`solus-cloud/src/lib/server/auth/account-tokens.ts:97`),
and each token that a host holds for a person has one. The host may only read the
person's directory (`GET /v1/hosts`, `readDelegatedDirectory`).

## 2. Vocabulary

- **cloud machine** — a host of kind `cloud` (plan 034). Two ways to get one:
  - **made by Solus** — Solus Cloud runs its compute (`hasManagedCompute`).
  - **joined** — the organization runs it, and it joined with a link code.
- **acting host** — the host whose token makes a request for a person
  (`actingHostId` of `DelegatedHostCaller`).
- **this host** — the host that runs the agent's turn. A tool never deletes,
  changes, stops, or restarts this host.
- **machine card** — the question card of kind `cloud-machine` (§6). It
  collects choices that the person did not give. It does not make the change.

## 3. Decisions

Maintainer decisions:

1. **Tools:** list, create, edit (packages and setup script), start, stop, restart,
   delete, and join a machine that the organization runs (§5); and the
   organization tools of §10.
2. **A host never deletes or edits itself.** Solus Cloud enforces this (§4). The
   tool also refuses before it sends a request.
3. **Signed-in only.** A turn whose person has no account on this host does not
   get the tools in its catalog: not in the Claude MCP server, not in the Codex
   tool list (§7).
4. **A card only when a choice is missing.** When the person said what to change,
   the tool acts at once. When they did not (for example, "edit my cloud machine"),
   the tool shows the machine card.

Signed off after the first draft:

5. **The host makes every change, with its delegated token.** Solus Cloud admits a
   live delegated token on the lifecycle routes (§4). The card only collects
   choices; the tool then sends the request. One write path, not one on the host
   and another on each client.
6. **Stop and restart of this host are refused too.** A stop or restart of this host
   ends the turn that asked for it. (Decision 2 names only delete and edit.)
7. **Delete asks for the provider's approval** (`requiresApproval: true`), as
   `remove_host` does. Deletion destroys the disk and cannot be undone. Create,
   edit, and restart do not ask, so that they follow decision 4.
8. **A link code never goes into the transcript.** The transcript is mirrored to
   the organization, and a code joins any machine to it for ten minutes. The join
   tool mints the code on the host and uses it there (§5). It is not on a command
   line either, where `ps` shows it to every user of the machine.
9. **Start and stop are in the first change** (§8). They are the same routes and
   the same rules, and they are the controls for cost.

## 4. Solus Cloud

One new admission check, in `src/lib/server/uplink/v1.ts`:

```ts
/** A person who changes a machine: the website, their own token, or a host that acts for them. */
requireMachineCaller(event): Promise<
  | { ok: true; userId: string; actingHostId: string | null; organizationId: string | null }
  | { ok: false; response: Response }
>
```

- A cookie session or an own token gives `actingHostId: null`, as today.
- A delegated token is admitted only while its delegation is live
  (`delegatedHostCaller`, which also checks the grant). A sign-out ends it at once.

Rules for a delegated caller, checked in the route before the work:

| Rule | Routes | Refusal |
| --- | --- | --- |
| The target is not the acting host | `spec`, `machine` DELETE, `restart`, `stop` | `403 acting_host_is_target` |
| An organization delegation acts only in its organization | all, and the `organizationId` in the body of `POST /v1/hosts` and `POST /v1/enrollment-tickets` | `403 outside_delegation` |
| A personal delegation acts in each organization where the person has a role | all | role checks as today |

The role rules do not change: a member creates and joins; an owner edits and
deletes. Each audit log entry of a delegated call names the acting host.

Routes:

- Change `POST /v1/hosts`, `start`, `stop`, `restart`, `spec` PATCH, `machine`
  DELETE, and `POST /v1/enrollment-tickets` to `requireMachineCaller`.
- Add `GET /v1/hosts/:hostId/spec`: the current packages and setup script, for the
  edit card. Owner only, like PATCH.
- Add `managedHostCatalog` to the delegated `GET /v1/hosts` answer. The host must
  know the sizes, and `GET /v1/account` stays closed to delegated tokens.

Tests in `solus-cloud`: a delegated token can create and restart; it cannot edit,
stop, restart, or delete its own host; an organization delegation cannot act in
another organization; a revoked grant cannot write; a member cannot delete.

## 5. Agent tools

A new group `cloud` in `solus-toolbox.ts`, in
`packages/server/src/execution/agents/tools/cloud-machine-tools.ts`. Each request
goes through `accountReadsOfServer.fetch(userId, scope, path, init)` with the
token that this host holds for the person of the turn. The scope is the turn's
organization when it has one, else `personal`.

| Tool | Input | Card | Approval |
| --- | --- | --- | --- |
| `list_cloud_machines` | `organization?` | never | no |
| `create_cloud_machine` | `organization?`, `name?`, `size?`, `packages?`, `setup_script?`, `reason` | when the organization is not clear (several, none named), or the person asked to choose | no |
| `update_cloud_machine` | `host`, `packages?`, `setup_script?`, `reason` | when neither field is given | no |
| `restart_cloud_machine` | `host` | never | no |
| `start_cloud_machine` / `stop_cloud_machine` | `host` | never | no |
| `delete_cloud_machine` | `host` | never | yes |
| `join_cloud_machine` | `organization?`, `address`, `ssh_target`, `identity_file?` | when the organization is not clear | no |

- `host` is an id, installation id, or exact name from `list_cloud_machines`.
- An absent size is the catalog's default (`managedHostSpecRequestSchema`).
- `create_cloud_machine` waits until the directory lists the new host (the rule of
  `ManagedHostsStore.create`), then returns its id, name, state, and a note:
  "Use it with start_sessions."
- `update_cloud_machine` says that a running machine restarts to take the change.
- `join_cloud_machine` mints a code with `POST /v1/enrollment-tickets` and runs
  `solus setup --address URL` over SSH with the SSH runner of `add_host`. The
  code goes on the command's standard input (or in `SOLUS_LINK_CODE`, the boot
  variable of plan 034 §3), never in its arguments. The code stays in the tool. The result is the output of the command
  without the code, and the new host from the directory. The address must be
  `https:`. The description lists the conditions from `docs/cloud-machines.md`
  (new data directory, HTTPS front, cloud hosts allowed).
- Each tool returns the refusal of Solus Cloud as one sentence that a person can
  act on: "Only an organization owner can change this machine."

## 6. The machine card

A new question kind `cloud-machine` in `packages/contracts/src/cloud-machine-card.ts`,
with the same flow as `host-link` (`add-machine.ts`, `askOnCard`):

```ts
type CloudMachineAsk =
  | { mode: 'create'; reason: string; organizations: { id: string; name: string }[];
      catalog: ManagedHostCatalog; draft: { organizationId?: string; name?: string; size?: string; packages?: string[]; setupScript?: string } }
  | { mode: 'edit'; reason: string; host: { id: string; name: string; state: ManagedHostLifecycle; size: string | null };
      current: { packages: string[]; setupScript: string } }
  | { mode: 'join'; reason: string; organizations: { id: string; name: string }[]; address: string }

type CloudMachineAnswer =
  | { status: 'chosen'; organizationId?: string; name?: string; size?: string; packages?: string[]; setupScript?: string }
  | { status: 'declined' }
```

- The tool puts everything the card needs in the ask. The client makes no
  account call, so the card is the same on desktop, web, and mobile, and works on
  a client that is not signed in.
- The card answers with `respondQuestion`. The tool checks the answer against the
  ask again (an organization from the list, a size from the catalog, the pattern
  and length limits of packages and script), then sends the request.
- Decline closes the card. The tool returns "The person declined. Do not ask again
  unless they ask you to."
- A reader who may only view the session sees "Waiting for an editor".

Clients:

- Desktop and web: `components/conversation/CloudMachineCard.svelte`, beside the
  Add machine card. Reuse the fields of `fleet/AddCloudMachine.svelte` through a
  shared field component, not a copy.
- Mobile: `apps/mobile/src/features/threads/CloudMachineCard.tsx`, from
  `LinkRequestCard.tsx`: the card in the conversation, and a `Sheet` with the
  fields. The design is in the render that goes with this plan.

## 7. Signed-in only

`AgentTool` gets one optional answer:

```ts
/** False when this tool is not for the person of the turn; its catalog leaves it out. */
isOffered?: (person: ToolPerson) => boolean
```

- `enabledAgentTools` (`agent-tool.ts`) leaves out a tool whose `isOffered` is
  false, so neither the Claude MCP server nor the Codex tool list names it.
  `executeAgentTool` checks again, because a sign-out can come during a run.
- The cloud tools are offered when this host holds a delegation for the turn's
  person (`delegations.holders()`). A signed-out desktop, a guest, and an
  automation of a person who signed out do not get them.
- The catalog is built at run start. A sign-in in the middle of a run shows the
  tools from the next run. The execute check tells the agent "Sign in to Solus
  to manage cloud machines" if the account ended.

## 8. Order of work

1. Solus Cloud: `requireMachineCaller`, the rules, `GET spec`, the catalog in the
   delegated directory, tests.
2. Host: `isOffered`, the `cloud` group, list/create/restart/start/stop/delete,
   tests with a fake account plane.
3. Contract and cards: `cloud-machine` kind, update and create with a card, the
   Svelte card, the mobile card, card tests on each client.
4. `join_cloud_machine` with SSH.
5. The organization tools (§10), then the sharing tools (§11) after sign-off.
6. Docs: `docs/cloud-machines.md` (agents can do this), the tool list.

## 9. Surfaces

- Entry points: the conversation only. Settings → Machines keeps its form.
- Clients: the card on desktop, web, and mobile.
- Providers: Claude and Codex take the same tools through `enabledAgentTools`.
- Connection modes: the host makes each request, so a remote web client and a
  phone act the same as the desktop.
- Reverse states: create ↔ delete, start ↔ stop. Edit can set the old values again.

## 10. Organization tools

In the same change (maintainer, 2026-11-26). Each one uses a route that exists;
§4 admits the delegated token on each one, with the same organization rule.

| Tool | Route | Who | Approval |
| --- | --- | --- | --- |
| `list_organization_members` | `GET /v1/orgs/:id/members` | member | no |
| `read_organization_policy` | `GET /v1/orgs/:id/policy`, `host-policies` | member | no |
| `update_organization_policy` | `PUT /v1/orgs/:id/policy`, `host-policies` | owner | yes |
| `list_provider_seats` | `GET /v1/vault/seats` | member | no |

- `update_organization_policy` asks for approval as delete does: a change applies
  to every member and every host of the organization at once.
- A refusal from a create or a join names the rule ("This organization's owners
  turned cloud hosts off"), so the agent can offer `read_organization_policy`.

## 11. Sharing (needs sign-off)

Sharing has two parts in Solus today. Neither has an agent tool.

**A session or a work.** The host owns who may open it (`shareGet`, `shareSet`,
`shareSetLink`, `packages/contracts/src/sharing.ts`). The tools call these RPCs
as the person of the turn (`asPerson`, `person-rpc.ts`), so the person's own
rights apply and Solus Cloud does not change.

| Tool | Does | Approval |
| --- | --- | --- |
| `read_sharing` | who may open a session or a work, and whether a link is on | no |
| `share` | add, change, or remove a person, a team, or the organization (ids from `list_organization_members`) | no |
| `set_share_link` | turn the link on with a role and a lifetime, or off | no |

- **The link secret never goes into the transcript.** A guest link opens the
  resource to anyone who has it. The tool says that the link is on and when it
  ends; the person copies it from **Share**.
- These tools work signed out too, for people this host knows. They are not in
  the signed-in-only group.

**A host.** An owner shares a personal host with an organization, so its members
run work on it (`POST` and `DELETE /v1/hosts/:id/organizations/:organizationId`).

| Tool | Does | Approval |
| --- | --- | --- |
| `share_host` | share a personal host with an organization | yes |
| `unshare_host` | take it back from one organization | no |

- `share_host` asks for approval: members can then run agents on the machine.
- A host can share or unshare itself: that does not end the turn.

## 12. Order with plan 034

The follow-up work of plan 034 is not committed. It is in the task folder
`~/.solus/solus-task-folders/solus-unify-cloud-machines-0f210a8c` (83 changes in
`solus`, 53 in `solus-cloud`). It changes the same files as this plan:
`solus-cloud/src/lib/server/uplink/v1.ts`, `auth/host-access.ts`,
`contracts/src/uplink.ts`, `host-policies.ts`, `policy.ts`, `boot-server.ts`, and
the conversation cards. It also adds `SOLUS_LINK_CODE` (`host/boot-link-code.ts`),
which `join_cloud_machine` uses. This plan starts from a branch that has that
work committed.
