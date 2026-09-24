# Shared hosts: collaboration decisions and remaining gaps

Status: PLAN — decisions recorded 2026-09-23; no work started.
Revised 2026-09-23 against HEAD `07624969`.
Task: `01M36BCWFTJS1DVN3A6S9EHCNB` — Design Collaborative Multi-Host Sessions.

The cloud plans this file cites (`cloud-service-model.md`, `managed-hosts.md`,
`project-model.md`, `multiplayer-*.md`, `provider-seats.md`) are under
`docs/plans/` at HEAD `07624969`.

## Decisions

| # | Question | Decision |
| --- | --- | --- |
| D1 | Is a cloud (managed) host a trusted team box, or must members be isolated? | A shared team box, for now. Members trust each other. No per-member OS identity. |
| D2 | May any editor answer another person's tool permission, question, or plan approval? | Yes. |
| D3 | May a teammate steer a turn that runs on another person's seat? | Yes. |
| D4 | Is per-member or per-session compute the long-term direction? | One shared Sprite per organization for now, to keep the Sprites migration small. Per-member compute is not decided. |
| D5 | Project setup scripts for cloud checkouts. | Not needed. Remove the setup-script step from `project-model.md` §7. |
| D6 | Session handoff or transfer between hosts (P6). | Not now. `moveTabToHost` stays "before the first Send" only. |
| D7 | May two members work in one session on the shared Sprite? | Yes. Each person's own prompt runs on their own seat; a steer runs on the turn author's seat (D3); any editor answers approvals (D2). |
| D8 | Whose seat and integrations does an automation run on? | Its creator's: the run's turn author is the person who created the automation. (Was Q1.) |
| D9 | Where does an automation created on the cloud run by default? | On the cloud host. |
| D10 | Does D1 also hold on a personal host shared with an organization? | Yes: the same trust model. (Was Q2.) |
| D11 | Label a teammate's steer? | No steer label. Instead, the work "Multiplayer: people in the conversation view" (`c21fe863-5cd3-4b21-a5ef-87fa3ae3a1a2`) lists every place the conversation view should name a person. (Replaces Q3.) |

### What D1 means

On every host, an agent runs as the host's OS user. Codex runs with full
access outside plan mode. A member who can prompt on a host can therefore read
everything that user can read: every checkout, every transcript, every seat
directory, and the host's secret store.

- On a cloud host this is D1: accepted.
- Per-member workspaces (`<root>/<userId>`), worktree defaults, and private
  sessions organize the work. They are not security boundaries. Do not
  describe them as security boundaries in the UI or the docs.
- The same is true of a **personal host shared with an organization**: members
  get the owner's disk and the owner's provider logins. D10 accepts this. The
  Share-with-organization action must say so in plain words.

### Fly Sprites (2026-09-23)

Managed hosts are moving from a Fly Machine to one Fly Sprite for each
organization (`packaging/managed-host/sprite-boot.sh`, uncommitted). The
server and every agent still run as one `solus` user, so D1 and every item
below stay the same. What changes:

- **Edge.** The Sprite URL replaces cloudflared and is public. The server's
  grant check on the proxied listener is the only gate. Sprites' own URL auth
  admits Fly organization members, not Solus members, so do not rely on it.
  The URL routes to one port, so a member's dev server is not public.
- **Checkpoints cover the whole disk.** A restore rewinds every member's
  checkouts, sessions and seats. Only a host admin may restore, as a team
  action.
- **A pause stops everyone.** Sprites docs: "Services don't keep a Sprite from
  pausing." Only inbound HTTP work or a live Tasks API hold (1 hour at most,
  renewed) keeps it running. An agent turn makes outbound calls only, so a turn
  with no client connected can pause. Hold a task while a turn runs, while a
  permission or question waits, and for scheduled automations. The managed-host
  README says the opposite ("A running service keeps the Sprite awake"); fix it.
- **Operators.** A Fly token can `sprite exec` into every organization's
  Sprite. Keep it in the control plane only.

Sprites make per-member compute cheaper later: idle compute is not billed, so
a Sprite for each member costs about the same compute as one shared Sprite.
That would give a VM boundary between members. It is not planned (D4).

### What D7 needs

Presence, typing, follow, queue authors and per-author seats already work in a
shared session. Missing:

- **Authors are live-only.** The host stamps `author` on the live
  `user_message` and `prompt_queued` events only (`control-plane.ts`
  `turnAuthorOf`). After a reload, and in the cloud mirror, the bubbles carry no
  name, so two people cannot tell who asked what. Store the author with the
  user message. Plan 003's durable message table is the natural home; ask
  there before adding a second store.
- **Both people need a seat on the Sprite.** The second person's first prompt
  gets `SEAT_REQUIRED` and the seat card. Show the seat state in the session
  band before they type, not after they send.
- **Commit author in a shared session.** An agent commit takes the author of
  the turn that made it; a composer commit takes the person who clicked (item 1).
- Items 3 (approval cards name people), 5 (notifications reach both people),
  and plan 003's Stop fix apply directly. Item 6 must not warn the people who
  are already in the session that uses the tree.

## Not in this plan

- Project setup scripts (D5) and session handoff or transfer (D6).
- Per-member OS identity and per-member compute (D1, D4).
- Queue, steer and stop behavior, and durable `clientPromptId`
  de-duplication. Plan 003 owns the session message path. Two facts for it:
  Stop cancels every queued prompt, including other people's
  (`control-plane.ts` `stop`), and prompt de-duplication is in memory only
  (`acceptedClientPromptIds`, 512 entries).

## Work

Ordered by value. Each item names what is wrong now, the change, and its proof.
Every UI item covers desktop, web and mobile, and Claude and Codex.

### 1. Commit author and push credential per member on a cloud host

Now: `git commit` takes the checkout's config. On a dispatched clone that is
`<login>@users.noreply.github.com` of the device that sent the dispatch.
Otherwise it is the host's global identity, which only a host admin sets.
`git push` uses the checkout's credential helper: a device delegation, or the
host's own token (`solus git-credential`, "never a leased credential").
GitHub API calls are already correct per member (`integrationUserFor`).

Change: on a managed host, commit and push as the acting member. Set the
author from the member's account and serve the push credential from the
member's account integration, in the commit composer and in agent shells.

Proof: two members commit and push in their own checkouts on one Lab managed
host; each commit carries its member's author and each push uses its member's
token.

### 2. One clone per member and repository

Now: dispatch clones are keyed by device
(`<root>/<userId>/solus-remote/<deviceId>/<repoKey>`, `dispatch-checkouts.ts`).
One member on a laptop and a phone gets two clones of one repository.

Change: on a managed host, key dispatch clones by member and repository key.

### 3. Approval cards name the people (D2)

Now: `permission_request` carries no turn author; `permission_resolved`
carries no responder. `respondPermission` and `respondQuestion` discard the
session id and find the request by question id alone
(`session-handlers.ts`), so the access check proves only that the caller
edits *some* session.

Change: check that the question belongs to the session in the call. Put the
turn's author on the request and the responder on the resolution; show both
on the permission, question and plan cards.

### 4. Automations run as their creator (D8, D9)

Now: any member may list, change, run or delete any automation. A run has no
author, so it runs on the host login in `auto` mode with the host's
integrations. On a cloud host, members sign in their own seats only, so the
host login is probably not signed in and the run fails at spawn (check this
on a Lab managed host). On a shared personal host, a member's automation runs
on the owner's login.

Automations live in each host's own SQLite (`automations` table, no owner
column). `createdBy` is `{ kind: 'user' | 'agent' }` with no user id. Neither
`startAutomationSession` nor `dispatchAutomationRun` passes an actor, so
`seatForTurn` answers the host login and tools use the host's connections.

**4a. Run as the creator (D8).**

- Store the creator's user id on the automation. Set it on the server from the
  caller's principal in `automationCreate`, and from the calling session's
  turn author in the `create_automation` tool. Never take it from the client.
- At run time, build a `TurnActor` from the stored creator and pass it to
  both dispatchers. The run then uses the creator's seat, the creator's
  integrations, and shows the creator as the turn author.
- No seat: the run fails with `SEAT_REQUIRED`, is recorded as failed with that
  reason, and the creator gets a notification. No fallback to the host login.
- An automation made over a local connection by the host owner keeps the host
  owner as creator. That is today's behavior on a single-person host.
- Who may change an automation: its creator or a host admin. Any member may
  read it and its runs.

**4b. Host choice: no new picker.** The builder already has a Host row
(`AutomationBuilder.svelte`), but it is the wrong list and the wrong default:

- It lists every connected host with the `automations` capability. Use the
  run-on picker's host list instead (`serversStore.executionServers`, the
  managed host with its lifecycle state, `canRunOnHost`). That excludes the
  workspace service.
- Default (D9): when the builder is opened at a Solus Cloud origin, or from a
  session that runs on the cloud host, choose the organization's cloud host.
  Otherwise keep today's default: the host of the focused session. The
  `create_automation` tool already creates on the host that runs the session,
  so a cloud session makes a cloud automation.
- The Host row is read-only after save. Moving an automation to another host
  is not in scope; delete and create again.
- The launchpad ("describe it" and templates) opens its draft on
  `defaultServerId()`. Apply the same default there.

**4c. Scheduled runs on a Sprite.** The scheduler is a 30-second timer inside
the host process. A paused Sprite runs nothing until it wakes, then fires each
missed automation once. The control plane must wake the Sprite before a
scheduled run (see "A pause stops everyone").

**4d. The workspace service must not hold automations.** It registers the
automation handlers and starts the scheduler, and its capabilities report
`automations: true`, because `hasHandler` ignores roles. Refuse automation
definitions there, or make the capability respect the roles.

Proof: a Lab managed host with two members. Member A creates an automation;
its run carries A as author and uses A's seat. A run whose creator has no seat
fails with `SEAT_REQUIRED` and does not use the host login. Member B cannot
edit it. The builder at a cloud origin chooses the cloud host.

### 5. Attention and push notifications go to the right people

Now: attention entries and web push go to every client on the host, not
filtered by who may open the session; `listAttention` is open to guests.

Change: filter by the session's audience, as `eventVisibleTo` does for other
events. Keep "needs input" loud for the turn's author and quieter for other
editors.

### 6. A busy working tree is visible

Now: nothing warns when two sessions, or a git action and a running agent,
use one working tree (`gitCheckoutBranch`, `gitDiscard`, commit and push).
This applies to every host, desktop included.

Change: the host knows which running sessions use which tree. Git actions and
a session start in a busy tree show "Another session is running in this
folder" and ask before they continue. Not a lock.

### 7. Private choice when a session starts on a cloud host

Now: every session on a managed host starts shared with the organization as
editors. It can be narrowed only after it exists.

Change: a "Private" option in the run picker for a managed host. Private
remains an organization choice, not security (D1).

### 8. Removing a member

Now: the member's sockets live until their grant expires; running turns
continue; seats wait for the 30-day sweep; their workspace and worktrees
stay; their private sessions have an owner nobody can act for.

Change: on removal, end their sockets and turns, remove their seats, and let a
host admin transfer or delete what they owned. Keep their workspace until an
admin removes it.

### 9. Dev-server discovery on the cloud image

Now: `target-scanner.ts` needs `lsof`; the managed-host image does not install
it. Hand-typed URLs work.

Change: install `lsof` in `packaging/managed-host/Dockerfile`.

### 10. Cloud onboarding deploy blockers

From `cloud-onboarding.md` §9–§10: the squashed migration histories break an
existing database, and the flow was never run in a browser.

## Open questions

Q1–Q3 are answered by D8, D10 and D11.

- **Later, only if per-member Sprites return (D4).** When B prompts in A's
  session on A's Sprite, whose seat runs it? Where do team automations run?
