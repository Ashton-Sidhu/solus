# Shared hosts: collaboration decisions and remaining gaps

Status: IN PROGRESS — decisions D1–D17 recorded; C1, C2 and C3 resolved.
Steps 1–7 (stages 1 and 2) implemented in the working tree on 2026-09-29, not
yet committed; see "Implementation record" at the end. Stages 3–6 wait on the
checks the execution plan names.
Revised 2026-09-29 against HEAD `bf4e8fe7` plus the working tree, which holds
the uncommitted plans 007 (server layout), 008 (Workspace HTTP API) and 009
(organization VMs).
Task: `01M36BCWFTJS1DVN3A6S9EHCNB` — Design Collaborative Multi-Host Sessions.

## Related plans and ownership

- **Solus Cloud feature plan** (Solus work `de142de0-7fbf-4ed2-a7e6-4cb982a733f2`,
  revision 18). It owns canonical organization scope, admission, the acting
  user of a turn, run authority, scoped delivery, push recipient scope, the
  cloud Codex connection, and P6 transfer. Its phase P7 is the home of every
  scope or actor change below. **Do not build that infrastructure twice.** This
  plan records the collaboration requirement, the evidence, and the proof.
- `plans/009-organization-vms.md` — attached machines, run authority, session
  admission, and the removal of `SOLUS_MANAGED`.
- `docs/plans/organization-scope.md` and `docs/plans/workspace-and-machines.md`
  — record homes, the default machine, and machine references.
- Solus work "Session Orchestration Layer" (`71f9ba58-9e67-4d1d-9e91-26eb31fb1eba`)
  — orchestration exchanges; all its state is in memory, with no new table.
- Solus work "Multiplayer: people in the conversation view"
  (`c21fe863-5cd3-4b21-a5ef-87fa3ae3a1a2`) — the per-element list for D11.

## Words used here

- **Solus API** — the record service, formerly the workspace service. It never
  runs agents.
- **Attached machine** — a machine attached to one or more organizations for
  organization work (`host/organization-attachment.ts`). New roots there need an
  organization and the person's run authority.
- **Solus-provisioned machine** — host category `managed`
  (`host/host-category.ts`): a machine Solus provisioned for one organization,
  now one Fly Sprite. It is always attached. "Cloud host" in the decisions means
  this machine.
- **Customer VM** — category `self-hosted`, attached to one or more
  organizations.

## Decisions

| # | Question | Decision |
| --- | --- | --- |
| D1 | Is a cloud (Solus-provisioned) machine a trusted team box, or must members be isolated? | A shared team box, for now. Members trust each other. No per-member OS identity. |
| D2 | May any editor answer another person's tool permission, question, or plan approval? | Yes. On an organization session, the answerer also needs their own run authority (plan 009). |
| D3 | May a teammate steer a turn that runs on another person's seat? | Yes. |
| D4 | Is per-member or per-session compute the long-term direction? | One shared Sprite per organization for now. Per-member compute is not decided. |
| D5 | Project setup scripts for cloud checkouts. | Not needed. |
| D6 | Session handoff or transfer between hosts. | Not now. The feature plan keeps it as P6, after P7. |
| D7 | May two members work in one session on the shared Sprite? | Yes. Each person's own prompt runs on their own seat; a steer runs on the turn author's seat (D3); any editor answers approvals (D2). |
| D8 | Whose seat and integrations does an automation run on? | Its creator's. The feature plan repeats this requirement (§3, §5 "Host-local behavior retained"). |
| D9 | Where does an automation created on the cloud run by default? | On the organization's Solus-provisioned machine. |
| D10 | Does D1 also hold on a personal host shared with an organization? | Yes: the same trust model. |
| D11 | Label a teammate's steer? | No steer label. The conversation-view work lists every place that must name a person. |
| D12 | Does Stop cancel other people's queued prompts? (2026-09-29) | No. Stop ends the running turn and keeps every queued prompt. See item 6. |
| D13 | Must prompt authors survive a reload? (was C2; 2026-09-29) | Not now. Names are live only; a known limit. The design is kept in C2 for later. |
| D14 | Sharing of new sessions on an attached machine (was C3; 2026-09-29) | Project sessions start shared with the organization as editors. Chats start private on every machine until shared. See item 12. |
| D15 | Where does a person see their mentions? (2026-09-29) | In a notifications hub, planned separately. Mentions ship first without notifications; item 13 only produces the facts the hub will read. |
| D16 | Do mentions in a document body notify? (2026-09-29) | Yes, eventually, through the hub, once when the mention is first saved. |
| D17 | Do organization task comments take mentions? (2026-09-29) | Yes. |
| C1 | Where does an automation live? (resolved 2026-09-28) | On the execution machine: storage and scheduling stay there. The automation's organization and creator still govern access and execution. The Solus API stores no schedules. |

## What D1 means

Every agent on a host runs as that host's OS user. On a Solus-provisioned
machine this is `solus` (`sprite-boot.sh:31,77`), and member seats are under
`/data/state-seats`, owned by that user. Codex runs with full access outside
plan mode. A member who can prompt on a host can read everything that user can
read. The feature plan agrees: "Same-OS-user execution is not hard tenant
isolation."

- Every organization member gets a per-member workspace `<root>/<userId>` and
  chat folder `<root>/<userId>/.chat`, on any host, attached or not
  (`transport/handlers/setup-handlers.ts:310,324`, decided only by
  `principal.kind === 'org-member'`). The code comment says "not a boundary".
  Do not describe these folders as security in the UI or the docs.
- D10: the same holds on a personal host shared with an organization. The
  Share-with-organization action must say so in plain words.

## Fly Sprites

- **Edge.** The Sprite URL is public; the server's grant check is the only gate.
- **Checkpoints cover the whole disk.** Only a host admin restores, as a team
  action.
- **A pause stops everyone.** The README says so (`packaging/managed-host/README.md:47-53`,
  "That hold is not built yet"). The hold is item 3.
- **Operators.** A Fly token can `sprite exec` into every Sprite. Keep it in
  the control plane only.

## Resolved conflicts

### C2 — Where does a prompt's author live after a reload? (D13: deferred)

Decision (2026-09-29): prompt authors stay live only for now. A reload, another
device, and the Solus API's transcript projection show no names on prompts.
The conversation-view work records this as a known limit; F1 and F6 wait.

What is stored now:

- `user_message.author` is live only (`execution/session-runtime.ts:1971-1974`).
- `session_records.owner_user_id` and `session_admissions.owner_user_id`: one
  person per session, the starter.
- Insights `spans.user_id`: one person per turn, only for turns with an account
  user. Nothing reads spans on a history reload.

When this work starts, the store is small; the key is the real work:

- **Store.** A small table keyed by (session, message key) with the author's
  user id. Not a column on `session_messages`: that table is the transcript
  index, rebuilt from the provider files, so a rebuild would lose a value that
  only the host knew. The table goes against the "no new table" decision of the
  orchestration work, which was about orchestration state; confirm with the
  feature plan's owner, who owns the actor.
- **Key, Claude.** `SDKUserMessage` accepts an optional `uuid`
  (`@anthropic-ai/claude-agent-sdk`), but `buildUserMessage`
  (`execution/agents/claude/claude-backend.ts`) does not set one. Set it, then
  prove that the CLI writes that uuid on the transcript entry, and that the
  history reader (`claude-history-page.ts`) keeps it.
- **Key, Codex.** `turn/start` returns a turn id that the thread history keeps.
  A steer (D3) joins the running turn, so a turn can hold prompts from two
  people: the key must be the turn id plus the input's place in the turn.
- **Read and mirror.** The history reader joins the table; the transcript
  mirror sends the author with each user row to the Solus API.

### C3 — Who may open a session on an attached machine? (D14)

Decision (2026-09-29): a new project session on an attached machine starts
shared with the organization as editors (D7 needs it). A new chat starts
private on every machine until its owner shares it. Item 12 makes the code
follow this, and plan 009 §9 must be corrected: members of the organization do
get editor on a customer VM's project sessions.

Current code (read 2026-09-29). Two steps give a new session its access:

1. The claim (`claimSession`, `transport/handlers/session-handlers.ts`). The
   starter owns the session. In an organization space
   (`isOrganizationSpace`: an organization member on a `managed` host), a
   project session also gets the organization editor grant; a chat stays
   private (Scratchpad decision S5).
2. Admission (`admitOnAttachedMachine`, `execution/sessions/turn-organization.ts`).
   On an attached machine a new root must be organization work. It then calls
   `adoptForOrganization` (`sharing/share-manager.ts`), which gives the
   organization the editor grant whatever the folder.

| Machine | New project session | New chat |
| --- | --- | --- |
| Personal computer (never attached), owner | Private (Local) | Private (Local) |
| Personal computer shared with an organization, a member | Private to that member; the host owner sees everything | Private to that member |
| Customer VM, attached | Organization editors (admission) | Organization editors (admission) |
| Solus-provisioned machine (always attached) | Organization editors (claim and admission) | Organization editors (admission overrides the private claim) |

A pairing connection on an attached machine cannot start a new root
(`ORGANIZATION_REQUIRED`). A continuation keeps the access it had.

Plan 009 §9 says: on a customer VM, "only its starter and the owner can watch
it live, because a customer VM is not an organization space". The code
comment on `adoptForOrganization` says the opposite ("the organization's
members hold the editor grant on the machine as they do on its Solus API"). A
member still needs a grant from the account plane to reach the VM at all.
- `isOrganizationSpace` (`admission/principal.ts:238-239`) is still decided by
  `hostKind === 'managed' || 'cloud'` from the grant claims. It also makes
  organization owners host admins and gives unowned work to the team. The
  feature plan (§3.2) asks to replace such "managed" checks with record facts.

What must change for D14: only the chat row on attached machines. Admission
gives the organization editor grant to a chat too.

## Already done since the last revision

- **The Solus API holds no automations.** `boot-workspace-api.ts` starts no
  scheduler and registers no automation handlers, so it reports
  `automations: false` and the builder no longer lists it.
- **Answers need the answerer's authority on organization sessions.** On an
  attached machine, answering a published organization session calls
  `mayAnswerFor` (`turn-organization.ts:164-173`), which needs the person's own
  membership. A pairing connection is refused.
- **Member removal blocks new organization work.** A new turn, approval or
  answer on a published organization session needs fresh run authority, and the
  account plane checks membership each time.
- **At a Solus Cloud origin the default machine is the organization's
  Solus-provisioned machine** (`chooseDefaultMachine`,
  `client-core/src/server-registry.ts:115-119`). That serves D9 for the
  builder and the launchpad.
- Still done from before: answers go only to the asking session; a draft names
  the seat it needs before the first send; the Sprite README is correct.

## Work

Ordered by risk, then value. "Owner" says where the change belongs. Each UI item
covers desktop, web and mobile, and Claude and Codex.

### 1. Every turn has an actor and passes admission — owner: feature plan P7

These turns have no actor and skip `admitTurnOrganization`, which only the
`prompt` handler calls (`transport/handlers/session-handlers.ts:182-189`):

- Agent-started turns. `SessionOrchestrator` calls `createSession` and
  `promptSession` with no actor (`execution/orchestration/session-orchestrator.ts:225,278`).
- Automation runs (`execution/automations/automation-runner.ts:160-170`;
  `session-runtime.ts:2406-2459`, `permissionMode: 'auto'`).
- `retry` (`session-handlers.ts:356`), which has an actor but skips admission.

With no actor, `seatForTurn` answers the host login (`session-runtime.ts:1823`),
tools act as `INTERNAL_PRINCIPAL` with the host's connections, and Insights
records no user. On an attached machine such a turn is also a new root that
skips the "no new personal roots" rule: its record is born in the machine's
organization or Local, unpublished, with no owner.

Requirement for P7: a child turn's actor is the author of the parent turn that
called the tool; an automation run's actor is its creator (D8); both pass the
same admission as a person's prompt. The session tools (`read_session`,
`send_session`, `stop_session`, `start_session`) act with that author's share
role on the target (`execution/agents/tools/session-tools.ts:535-775` checks
only "own session" and "exists").

Proof: on a Lab Solus-provisioned machine, a member's parent turn starts a
child that runs on the member's seat, names the member, and is refused a
session private to another member; an automation with no creator seat fails
with `SEAT_REQUIRED` and never uses the host login.

### 2. Automations: organization and creator (C1 follow-through)

Scope and actor parts belong to P7; the rest belongs to this plan.

Still true:

- **Leak on a multi-organization VM (P7).** `listAutomations` is
  `SELECT * FROM automations` (`data/automations/automations-store.ts:314-321`).
  A member of A on a VM that also serves B lists B's automations. Only the
  client hides them (`automations.store.svelte.ts:57-61`).
- **Organization ignored at run time (P7).** `automations.organization_id`
  exists (`db/migrations.ts:474`), but the run takes the machine's
  organization.
- **No creator (P7).** `createdBy` is `{ kind: 'user' | 'agent' }` with no user
  id; the client still sends `{ kind: 'user' }` (`automations.store.svelte.ts:215`).
  A builder-made automation on a customer VM is `local`.
- **Anyone may change any automation (this plan).** No automation rule in
  `admission/access-policy.ts`. Change: the creator or a host admin edits,
  deletes, runs or cancels; any member reads.
- **Builder host list (this plan).** Options are still every connected host
  with the `automations` capability (`AutomationBuilder.svelte:109-122`). Use
  the execution machines instead, with the Solus-provisioned machine's
  lifecycle state; with no machine, say "Choose a machine" and do not save.
- **Automations page at a Solus Cloud origin (this plan).** The page lists from
  the primary (`AutomationsPage.svelte:63-68`), which is the Solus API there,
  so the page is empty even when the organization's machine has automations.
  List from execution machines.
- **Automation tools stay local.** `create_automation` writes to the machine
  that runs the calling session; this agrees with C1 and D9.

### 3. Sprite activity holds and wake-up — owner: this plan

Not built. `execution/activity-leases.ts` is a client heartbeat for git-status
work, not a Sprite hold. solus-cloud's `sprites-api.ts` has no tasks endpoint;
its sweep starts a stopped service only toward the desired state.

- Hold the Sprite awake while a turn runs and while a permission, question or
  plan waits; renew the hold (one hour at most).
- Wake the Solus-provisioned machine before a scheduled automation is due.
- Plan 009 limit: run authority lives in memory, so an automation or watch that
  wakes after a restart has no authority for Solus API writes. Item 1 and this
  item must be proved together.

### 4. Commit author and push credential per person — owner: this plan

Still true: plain `git commit` (`git/git-action-manager.ts:86,243`); the author
comes from the checkout's config or the host-admin global identity
(`setupSetGitIdentity`, `setup-handlers.ts:499-509`); a delegated clone writes
`<login>@users.noreply.github.com` (`setup-handlers.ts:722-724`); push uses the
device delegation or the host's own token (`providers/github/git-credential.ts:70`).
GitHub API calls already use the member's token (`vault/account-integrations.ts:45-54`).

Change: on a Solus-provisioned machine, commit and push as the acting person.
An agent's commit takes the author of the turn that made it; a composer commit
takes the person who clicked.

### 5. Attention and push reach the right people

- **Attention (this plan).** `attention.snapshotChanged` is still broadcast
  with no resource (`boot-server.ts:718`), so every member hears every session.
  Guests no longer hear the event, but `listAttention` is still open to guests
  (`access-policy.ts:316`) and returns the full list (`boot-server.ts:703`).
  Filter both by the session's audience. "Needs input" is loud for the turn's
  author and quieter for other editors.
- **Push (P7, feature plan §9).** Push still goes to every subscription
  (`notifications/push-service.ts:183`).
- **Git progress (this plan).** With no client id, `git.actionProgressed` is
  broadcast to every member (`worktree-handlers.ts:217-219`).

### 6. Stop keeps the queue (D12) — owner: this plan

Now: Stop drains every queued prompt, including other people's
(`session-runtime.ts:2291`, `_drainQueue` at `:3370-3386`).

Change: Stop ends the running turn only. Every queued prompt stays, and the
next one starts as usual. A person removes queued prompts one by one, as now
(any editor may, D2). Check the orchestration layer: a stopped exchange must
still settle `interrupted`, and a queued orchestration message must stay
queued.

Proof: Alice's turn runs and Bob's prompt waits; Alice stops; Bob's prompt
starts next. The same for Claude and Codex.

Unchanged: `clientPromptId` de-duplication is in memory only (512 entries).

### 7. A busy working tree is visible — owner: this plan

Still true: the only guard is between two git actions on one tree
(`git-action-manager.ts:319-320`). Warn when a git action or a new session uses
a tree where another session runs. Do not lock, and do not warn the people
already in that session.

### 8. One clone per member and repository — owner: this plan

Still true: dispatch clones are keyed by device
(`project-config/dispatch-checkouts.ts:30`). On a Solus-provisioned machine,
key them by member and repository. Also correct the stale path comment at
`contracts/src/types.ts:3019`.

### 9. Seat state for a member who joins a shared session — owner: this plan

Still true: `SeatNeededNotice` is mounted only in the draft pane
(`SessionDraftPane.svelte:363`); in an open session the person learns only from
the refusal card. Show the notice before they send. A steer (D3) needs no seat
of their own. When the feature plan's cloud Codex connection reaches
Solus-provisioned machines, the notice must name that source for Codex.

### 10. Removing a member — owner: this plan, with P7

Changed: organization sessions now refuse the removed person's new turns,
approvals and answers (plan 009). Still true: solus-cloud `removeMember` never
contacts the host; `seatRemove` has no caller; seats wait for the 30-day sweep;
Local records and system turns are not blocked; an organization owner cannot
transfer a departed member's resources (`share-manager.ts:313,336-364`).
Change: remove their seats and end their sockets on removal; let a host admin
transfer or delete what they owned.

### 11. Small fixes

- Add `lsof` to the `apt-get install` list in `sprite-boot.sh:27-28`, for
  dev-server discovery (`browser/target-scanner.ts:103`).
- Migrations: since 2026-09-25 both histories only add files. The earlier
  squash of `0000_init` still breaks a database made before it; reset those
  databases or restore the old history before the first deploy.

### 12. Chats stay private on attached machines (D14) — owner: this plan, with plan 009

Now: `admitOnAttachedMachine` calls `adoptForOrganization`, which gives the
organization the editor grant for every new root, chats included. On a
Solus-provisioned machine this overrides the private claim.

Change: at admission of a chat (`isChatFolder` on the session's folder), set
the owner and the organization as today, but add no organization grant. The
chat is still organization work (its record lives on the Solus API); only its
share list is private. The owner shares it with the normal Share action.
Check that the Solus API side also creates the record without the
organization grant.

Proof: on an attached Lab machine, member A's new chat is not listed or
openable for member B; A's new project session is. After A shares the chat
with the organization, B can open it.

### 13. Mention organization members (new, 2026-09-29) — owner: this plan

Request: in comments, works and documents, a person types `@` and picks a
member of the record's organization; the member is told.

What exists now:

- The document editor has one `@` picker for files, plans, sessions, tasks and
  works (`components/editor/references.ts`, `referenceExtensions.ts`,
  `reference-tokens.ts`). A person is not a kind in it.
- Comment threads only colour plain `@name` text (`comments/lib/comment-text.ts`,
  `CommentBody.svelte`). The text names nobody the host knows.
- The organization's people come from the account plane
  (`uplinkOrganizationDirectory`, `OrganizationDirectory` in
  `contracts/src/uplink.ts`: members and teams), loaded per host by
  `sharesStore.directoryFor` for the share dialog.
- There is no per-person notification store. Attention and push are per host
  (item 5), and push recipient scope belongs to P7.
- Plan 009 limit: the Solus API record API does not carry comments yet; an
  organization work's comments go through the queued delivery.

Proposed design:

- **Scope.** Mentions work on organization records only: works, their comment
  threads, and task comments whose record has an organization. A Local record
  has no organization, so its `@` picker shows no people.
- **One mention token.** The mention stores the member's user id, not the name.
  In a document it is a new `person` kind in the existing `@` picker and chip,
  with the same Markdown form as the other reference chips. In a comment it is
  the same token in the comment text. Readers see the current display name from
  the directory; a person who left shows the saved name, without a link.
- **Picker.** Members first by recent contact, then by name; teams are not
  mentionable in the first version. Keyboard-first, and a bottom sheet on a
  phone.
- **Access.** A mention never grants access. When the mentioned person cannot
  open the record, the composer says so and offers Share (the existing share
  dialog). The mention is still saved.
- **Notify (D15, D16): later, in the notifications hub.** This item does not
  store or send notifications. It keeps the mention's user id in the saved
  document and comment, so the hub can later find new mentions (a diff against
  the stored copy, so an edit does not notify twice), for comments and
  document bodies alike, and open the work, the anchor, or the thread. Push to
  one person needs P7's recipient scope.
- **Agents.** `read_work` shows a mention as `@Display Name`. Agents do not
  create mentions in the first version.
- **Surfaces.** Desktop, web and mobile share the editor and the comment
  composer; check the picker at phone width.

Proof: A mentions B in a comment on an organization work and on an
organization task; both keep B's user id and show B's current name. C, who
cannot open the work, is shown as "cannot open this" with Share. A Local work
shows no people in the picker.

## Execution plan (2026-09-29)

### Before the first pull request

- **Plans 007–009 must be committed first.** The working tree holds about 1,500
  uncommitted files from them. Every step below edits files they moved; do not
  stack this work on uncommitted changes.
- **P7 stays with the feature plan.** Item 1 and the scope parts of item 2 are
  not in this sequence. Agree with the feature plan's owner which person runs
  a turn, and reuse that answer in steps 5 and 9 below.
- One concern per pull request. Every UI step covers desktop, web and mobile
  (they share `packages/workspace-ui`), and Claude and Codex. Tests are focused
  unit tests; no build and no dev server.

### Stage 1 — Small server fixes (parallel, about one day each)

**1. Stop keeps the queue (item 6, D12).**
- `execution/session-runtime.ts` `stopSession`: remove the `_drainQueue` call.
  A turn that exits already calls `_processQueueForSession`, so the next queued
  prompt starts by itself.
- Keep the current behavior where it is correct: the rate-limit "Stop &
  discard" choice, and a stop while worktree setup runs. Check both.
- `orchestration.targetStopped` must settle only the running exchange; queued
  orchestration messages stay queued.
- Test: extend `tests/unit/queued-prompts.test.ts` or
  `session-runtime-queue-author.test.ts`. Alice's turn runs and Bob's prompt
  waits; Stop starts Bob's prompt, as Bob, on Bob's seat.

**2. Chats stay private on attached machines (item 12, D14).**
- `execution/sessions/turn-organization.ts` `admitOnAttachedMachine`: pass
  whether the session's folder is a chat (`isChatFolder`, `workspace.ts`).
- `sharing/share-manager.ts` `adoptForOrganization`: set the owner and the
  organization as today; add the organization grant only for a project session.
- Check the Solus API side: session admission and runner intake must not add
  the organization grant to a chat.
- Test: extend `tests/unit/organization-vm-records.test.ts`. On an attached
  machine, B cannot list or open A's new chat, but can open A's new project
  session; after A shares the chat, B can.
- Ask the plan 009 owner to correct §9.

**3. Host events reach only people who can open the session (item 5, this plan's part).**
- `boot-server.ts`: the attention snapshot is one list for all. Send each
  client only the entries for sessions it can open (the `roleFor` check that
  `eventVisibleTo` uses), and filter `listAttention` the same way.
- `admission/access-policy.ts`: a guest's `listAttention` returns only its one
  resource, or is refused.
- `transport/handlers/worktree-handlers.ts`: with no client id,
  `git.actionProgressed` goes to the session's audience, not to every member.
- Test: extend `tests/unit/presence-audience.test.ts` or add
  `attention-audience.test.ts`.

### Stage 2 — Fixes people see first (parallel with stage 1)

**4. Conversation view, step 1: no false "you".** F3 (`by` on the six events)
and the five "wrong today" rows of the conversation-view work. Server: pass the
principal from the respond, stop, dequeue and edit handlers into the runtime
events. Client: one label helper that answers "you" only for the reader's own
ids, and no name when the person is not known. Test: the event reducer keeps
`by`; the helper's three cases.

**5. Automations: machines and permissions (item 2, this plan's part).**
- `AutomationBuilder.svelte`: list execution machines
  (`serversStore.executionServers`, with the Solus-provisioned machine's
  lifecycle state); with no machine, show "Choose a machine" and do not save.
- `AutomationsPage.svelte` and `automations.store.svelte.ts`: list from
  execution machines, not from the primary, so the page is not empty at a Solus
  Cloud origin.
- Creator-or-admin edit rule in `admission/access-policy.ts`: after P7 stores
  the creator's user id. Until then, leave the rule as it is.
- Test: `tests/unit/automations-store-hosts.test.ts`.

**6. Seat notice in a shared session (item 9).** Mount `SeatNeededNotice` in the
conversation view when the reader's seat for the session's provider is not
connected; keep the draft-pane notice. A steer needs no seat, so hide the
notice while a turn runs. Test: `seat-need.ts` cases.

**7. `lsof` on the Sprite (item 11).** One line in `sprite-boot.sh`; a new
release makes it take effect.

### Stage 3 — Identity on the cloud machine (needs a short design check)

**8. Commit author and push credential per person (item 4).**
- Composer commits: `git/git-action-manager.ts` sets `GIT_AUTHOR_*` and
  `GIT_COMMITTER_*` from the calling person's account.
- Agent commits: the turn's launch environment carries the turn author's git
  identity.
- Push: the credential helper serves the acting person's GitHub token from
  their account integration. It needs the acting person on each git call; the
  launch environment carries it. Confirm the delivery with the feature plan
  owner, who owns account integrations.
- Test: `git-action-manager.test.ts` and `git-credential-entrypoint.test.ts`,
  with two people on one checkout.

**9. One clone per member and repository (item 8).** After step 8, because the
device-keyed clone exists for the device's delegated credential.
`project-config/dispatch-checkouts.ts` keys a member's clone by member and
repository. Test: `dispatch-history-roots.test.ts`.

### Stage 4 — Conversation view, steps 2–4

**10.** F2, F4 and the decision cards. **11.** The steer placeholder, the live
turn row, and the organization refusal card. **12.** Dividers, notices, and the
mobile header with presence and Share. F5 waits on P7; F1 and F6 wait on D13.

### Stage 5 — Larger items, each with a short spike first

**13. Sprite holds and wake-up (item 3).** Spike: can a process inside a Sprite
register a Tasks API hold, or must the control plane hold it for the host? The
Fly token must stay in the control plane. Then: the host reports "busy" (a
running turn or waiting input) and the next automation due time; the control
plane holds the Sprite and wakes it before the due time. Proof with item 1 of
P7: a woken automation must have authority.

**14. Busy working tree (item 7).** The runtime already knows which sessions run
in which tree (`isWorktreeInUse`). Git actions and a session start return a
"busy" answer; the client asks before it continues. Test: the git action and
the start both see a running session in the same tree.

**15. Member removal (item 10).** The host learns of a removal when it refreshes
its organization standing; it then removes the person's seats and ends their
sockets. A host admin may transfer or delete a departed member's resources
(`share-manager.ts` `transfer`). Needs a solus-cloud change; agree the signal
first.

### Stage 6 — Mentions (item 13)

**16. Mention token and picker.** Contracts: the `person` reference token and
its Markdown form. Client: the `person` kind in the editor's `@` picker and a
chip; the same picker in the comment composer; names from
`sharesStore.directoryFor`. No notification yet. Test: the token round-trips
through Markdown; a Local record offers no people.

**17. Access warning.** The composer checks the mentioned person's role on the
record and offers Share. Test: the warning appears only for a person with no
role.

**18. Notifications — moved to the notifications hub (D15).** The hub finds new
mentions in comments and document bodies (D16) and notifies once per new
mention. Not part of this plan; implemented by
[plan 015](015-notifications-hub.md) (`docs/plans/notifications-hub.md`).

### Order at a glance

| Order | Steps | Depends on |
| --- | --- | --- |
| 1 | 1, 2, 3, 4, 7 | Plans 007–009 committed |
| 2 | 5, 6 | — (creator rule in 5 waits on P7) |
| 3 | 8, then 9 | Design check with the feature plan owner |
| 4 | 10, 11, 12 | Step 4 |
| 5 | 13, 14, 15 | A spike each; 13 and 15 touch solus-cloud |
| 6 | 16, 17 | After the organization record paths of plan 009 are committed. Notifications wait for the hub (D15). |

## Open questions

- Later, only if per-member Sprites return (D4): whose seat runs a teammate's
  prompt on another person's Sprite, and where team automations run.

## Implementation record (2026-09-29)

Stages 1 and 2 are in the working tree on top of `fb020ccb`. Nothing is
committed. Each step has focused tests. The related unit tests show the same 15
failures as clean `fb020ccb` (test database and fixture problems that were
there before this work) and no new ones.

- **Step 1 (D12).** `stopSession` no longer drains the queue. It still drains
  when Stop cancels worktree setup, because the queued prompts were written for
  a worktree that will not exist. The rate-limit "Stop & discard" path is
  unchanged. `targetStopped` skips exchanges whose run is still queued, and the
  client card keeps a queued message open. The client no longer clears its held
  prompts on `interrupted`; they leave only on `prompt_dequeued`. Tests:
  `session-runtime-queue-author`, `session-orchestrator`,
  `agent-conversation-messages`, `session-event-acted-by`.
- **Step 2 (D14).** `adoptForOrganization` and `claimForRunner` take
  `shareWithOrganization`. Admission passes `!isChatFolder(cwd)`. The runner's
  session report carries `privateToOwner` for a chat, so the Solus API also
  creates it with no organization grant. Only the first report sets the grant;
  later reports do not change it. Plan 009 §9 now names the chat exception. Test:
  `organization-vm-records`.
- **Step 3 (item 5).** Each client receives only the attention entries for the
  sessions it can open, and `listAttention` uses the same filter
  (`attentionVisibleTo`, `sharing/event-audience.ts`). With no caller,
  `git.actionProgressed` goes to the session's watchers. Test:
  `attention-audience`.
- **Step 4 (F3).** `by` is on the six events. The host stamps it from the
  principal on stop, answer, rate-limit decision, and queue cancel and edit. A
  rejected plan is not a stop, so it names no one. For Codex, a permission's
  `by` waits for the provider's resolution. Claude sends no
  `permission_resolved`. The client stores `actedBy` on the stop notice and on
  the answered question. `actorName` says "you" only for the reader's own ids,
  and shows no name when the person is not known. The provider's "by user" alone
  now reads "Stopped". "Needs you", the question card, and the plan-decision
  comment need F2 and F5; they stay in step 10.
- **Step 5 (item 2).** The builder and the Automations page use execution
  machines (`components/automations/lib/automation-machines.ts`). A stopped or
  starting Solus-provisioned machine is shown but cannot be chosen. With no
  machine, the builder says "Choose a machine" and cannot save. The
  creator-or-admin rule still waits on P7.
- **Step 6 (item 9).** The open conversation shows `SeatNeededNotice` when the
  reader's seat is not connected and no turn runs (`seatNoticeShown`). The
  cloud Codex source waits on the feature plan.
- **Step 7.** `lsof` is in `sprite-boot.sh`. It takes effect with the next
  release.

### Stage 3 and step 14 (2026-09-29)

The maintainer approved stage 3 without the design check with the feature plan
owner. Each decision below is the smallest one that meets the item.

- **Step 8 (item 4).** Another session built this step in the working tree at
  the same time: `providers/github/member-git.ts` (a member's identity and a
  `--delegation member-<id>` helper through `GIT_CONFIG_*`), used by
  `git-action-manager.ts` for composer commits and pushes and by the seat
  (`TurnSeat.gitEnv`) for Claude and Codex turns. Test: `member-git-env`. This
  entry does not record its decisions; its author must add them. Open check:
  it applies to every person with account connections
  (`currentCredentialUserId`), not only on a Solus-provisioned machine.
- **Step 9 (item 8).** `dispatchCheckoutOwnerKey` keys a dispatch checkout. On
  a Solus-provisioned machine the key is the member, so one member has one
  clone per repository from every device. Elsewhere the key is the paired
  device, as before. The delegated credential and the `--delegation` helper use
  the same key, so `githubCredentialChain` still finds the checkout's
  credential (`dispatchCheckoutOwnerKeyOf`). The path comment in
  `contracts/src/types.ts` is correct now. Existing device-keyed clones on a
  managed machine are not moved; the next dispatch clones again under the
  member. Test: `dispatch-history-roots`.
- **Step 14 (item 7).** Decisions:
  - The answer is in the request, not a separate query: `gitRunAction` and
    the first `prompt` of a new session refuse with `WORKING_TREE_BUSY_CODE`
    (`execution/sessions/working-tree-busy.ts`). The request carries
    `allowBusyWorkingTree` after the person continues. Nothing is locked.
  - Busy means another session has a running turn (`activeRunRequests`) in the
    same tree: its worktree, else its checkout. A queued prompt alone is not
    busy.
  - Not busy for the people in that session: the asking session itself, a
    session the asking client watches, and a turn the asking person wrote.
  - A new session that makes its own worktree, and a chat folder, share no
    tree.
  - The client asks in one dialog (`components/busy-tree/BusyTreeConfirm.svelte`,
    store `contexts/git/busy-tree.store.svelte.ts`), mounted in the desktop and
    web shells; the web shell also serves mobile. Cancel is the first focus;
    Escape cancels. After Cancel, a new session's words go back to the
    composer. The refusal names the running turn's author when known.
  - Known limit: an outbox redelivery of a new session's first prompt gets the
    busy refusal as a failed send.
  - Tests: `working-tree-busy` (the git action and the start both see Alice's
    running turn; her own session and her client are not warned; the start
    continues with `allowBusyWorkingTree`) and `git-actions-busy-tree`.

### Stage 5 (steps 13 and 15) (2026-09-29)

The maintainer approved both steps. Nothing is committed. Both steps change
solus-cloud too; its migration is a new file (`0011_managed_host_activity.sql`)
and a journal entry.

**Step 13 (item 3) — spike.** The Sprites Tasks API is not a control-plane
API. It is served inside the Sprite on the management socket
`/.sprite/api.sock` (virtual host `sprite`) and needs no token
(docs.fly.io/sprites/keeping-sprites-running: `PUT /v1/tasks/:name` with
`{"expire": ...}`, one hour at most; `DELETE` releases). So the machine holds
itself, and the Fly token stays in the control plane. A paused machine cannot
wake itself, so the control plane wakes it: starting the Sprite service wakes
the Sprite (`sprites-api.ts` `startService`). The control plane stops a running
service by itself only for a new release or spec (`bringToDesired`); a
person's Stop or Restart is left as it is.

Decisions:

- **The hold** (`host/sprite-activity.ts`, managed host only, by
  `hostCategory()`). One task, `solus-work`, expiring after ten minutes and
  renewed every four, so a host that dies frees the Sprite. Held while busy,
  while a client was foregrounded within the last fifteen minutes, or while an
  automation is due within fifteen minutes; deleted otherwise. Checked every 30
  seconds.
- **Foregrounded** is the client's activity lease (`activityLease`, a 10-second
  heartbeat from every client): `ActivityLeases.lastForegroundAt()`. An open
  socket did not keep the Sprite running: without this, a tab left open on an
  idle host found the Sprite paused. A background tab does not hold it, and
  the report does not call it busy.
- **Busy** is `SessionRuntime.hasWorkToKeepAwake()`: `hasActiveWork()` or
  `hasWorkForUpdate()`, or a session `awaiting_input` or `awaiting_plan`. A
  rate-limit wait is not busy: it can last hours, and an inbound request wakes
  the machine.
- **Next due** is `nextAutomationDueAt()`: the earliest `next_run_at` of an
  enabled automation. Watches are not included.
- **The report.** `PUT /v1/hosts/:id/activity` with the host token,
  `{ busy, nextWakeAt }` (`hostActivityReportSchema`, contracts `uplink.ts`),
  sent when either value changes and renewed every hour. A report older than
  90 minutes (`HOST_ACTIVITY_REPORT_TTL_MS`) says nothing. solus-cloud stores
  it in `managed_host_activity`, apart from `managed_host` so a report does not
  move that row in the sweep's queue.
- **Wake.** `sweepManagedHostActivity` runs from the cron after the host sweep.
  It starts the service of a desired-running host whose `wake_at` is within ten
  minutes (the sweep runs every five, so the wake lands five to ten minutes
  early, inside the host's fifteen-minute hold), then clears `wake_at` until the
  host reports again. A host stopped on purpose is not woken.
- **Keep a busy host.** A reconcile does not restart a running host for a new
  release or spec while its fresh report says busy. It does not record the new
  release as applied and sets `restart_waiting`; the activity sweep runs the
  reconcile again once the host is not busy.
- **Plan 009 limit.** Run authority lives in memory. An automation that runs
  after a cold wake (the Sprite dropped its memory) has no authority for Solus
  API writes. This step does not solve that; P7 item 1 owns it, and item 3's
  proof must wait for it.

Open check, on a real Sprite: that the `solus` user can open
`/.sprite/api.sock` (`sprite-boot.sh` drops to `solus` with `setpriv`). If it
cannot, the host logs `sprite_hold_failed` once and does not hold; the boot
script must then give `solus` access to the socket.

Tests. Solus `sprite-activity`: busy for running, connecting, awaiting input
and plan, not for idle, completed or rate-limited; the next due time skips
paused and manual automations; the hold starts, renews and ends, and each
change is reported once and renewed hourly; the hold starts ahead of a due
automation; a machine that is not managed neither holds nor reports.
solus-cloud `managed-hosts.test.ts` ("managed host activity"): a paused host
is woken once, five to ten minutes before its automation; a stopped host is
not woken; a busy host keeps running through a new release and restarts once
it is idle; a stale busy report does not hold a restart.

**Step 15 (item 10) — spike.** The host has two signals today. A refused
delegation refresh calls `Delegations.onRevoked`, which stops the person's
runs and pauses their automations, but a refresh happens only when a token is
needed. The organization standing is read every five minutes, and at boot, and
did not name members. solus-cloud has no channel to push to a host (a managed
host has no tunnel), so `removeMember` does not nudge the host; the standing
refresh is the signal.

Decisions:

- **Signal.** `hostOrganizationSchema.memberUserIds`: every current member of
  each organization the machine is shared with (`readHostOrganizations`); an
  organization the host only delivers to lists nobody. Optional, so an older
  control plane removes nothing.
- **The rule reads the current list, not a change between two answers**
  (`host/departed-members.ts`), so a removal made while the machine was paused
  or restarting is still found. A socket admitted as a member of an
  organization that no longer lists them ends (`ws.disconnectWhere`, reason
  `member-removed`). A seat is removed (`SeatManager.remove`, which now has a
  caller) when its holder is a member of no shared organization and is not
  the host's owner; only when every shared organization sent its list.
- **Transfer.** `ShareManager.transfer` also lets a host admin
  (`isHostAdmin`) transfer a resource whose owner has left its organization
  (`hasLeftOrganization`), in the admin's own organization scope. The access
  gate lets a host admin reach the share manager for `shareTransfer`
  (`hostAdminDecidedByDomain`); everyone else still needs owner there.
- **Delete.** No RPC deletes a session, work or task, so there is nothing to
  open to a host admin.
- **UI.** No client calls `shareTransfer`; the share dialog has no transfer
  control. Adding one is not small, so the RPC is left for it.

Known limits: a removed person whose access token is still valid (five
minutes at most) can reconnect until the token expires, because the listener
runs only when the standing changes. Their runs and automations still stop
only through `onRevoked`, on the next delegation refresh.

Tests. Solus `member-removal`: removal drops Bob's seats and ends his two
sockets, and Cara and the local owner keep theirs; a standing without lists
removes nobody; a person still in another shared organization keeps their
seat and loses only that organization's socket; a host admin transfers a
departed member's session and a member cannot; while the owner is still a
member, the admin cannot; the gate passes a host admin and refuses a member.
solus-cloud: the standing lists members of a shared organization only
(`hosts.test.ts`, `managed-hosts.test.ts`).

Checks run: the focused tests above; `tsc` for `packages/server` and
`svelte-check` for solus-cloud show no error in the changed files; `oxlint`
shows only the complexity findings that were there before.

Not exercised: no dev server or browser run, so there is no visual check on
desktop, web or mobile.


### Stage 6 (steps 16 and 17) (2026-09-29)

Nothing is committed. Step 18 (notifications) stays with the hub (D15).

**Step 16 — mention token and picker.** Decisions:

- **One token, one contract.** `contracts/src/mentions.ts`:
  `[@Name](person://ref?userId=<id>)`. The id is the identity; the label is the
  name when the mention was saved. `mentionedPeople` gives the ids that the hub
  will read (D15, D16); `mentionsAsText` gives `@Name`. The editor token
  (`reference-tokens.ts`, kind `person`) and the comment parser
  (`comment-text.ts`, segment `person`) use the same contract.
- **Readers.** A mention shows the member's current name from the directory. A
  person who left shows the saved name in plain ink, with no chip and no accent.
  Before the directory loads, the saved name shows as a mention. Surfaces:
  work bodies (`editor/personRefExtension.ts`, registered by `DocumentModal`
  only), work and diagram and artifact threads (`CommentBody` →
  `mentions/PersonMention.svelte`), and task comments (`MarkdownNode`, local
  policy only).
- **Scope (D17).** `provideMentionScope` (`mentions/lib/mention-scope.svelte.ts`)
  gives the record to everything under the surface, as the comment viewer
  does: `WorkPane` for every work type, `TaskPage` for tasks. A record whose
  `organizationId` is `local` has no people, so `@` opens no menu. A directory
  of another organization than the record's is not used. A Google Docs reply
  (`ExternalCommentCard`) clears the scope: it writes to Google.
- **Names.** `sharesStore.directoryFor` and `sharesStore.load` through
  `warmMentionSources`, when the surface mounts and on the first `@`. The
  directory reaches readers with the scope (`mentions/lib/mention-context.ts`),
  so a comment body imports no store.
- **Picker.** `MentionPicker` (`mentions/lib/mention-picker.svelte.ts`) reads
  the query from the caret (`@` at a word start; spaces allowed once the query
  has begun; a spaced query that matches no one gives the words back). It
  draws in the existing reference popover (`UnifiedAutocompleteMenu`), which
  spans the window at phone width: the existing mobile picker pattern, not a
  new bottom sheet. Arrows move, Enter or Tab insert, Escape closes until the
  next `@`. Order: people who wrote in the work's threads, newest first
  (`recentCommentAuthors`), then by name. A task comment has no author id, so
  a task orders by name only. Teams are not offered.
- **Composers.** The one `CommentEditor` holds the picker, so every comment
  composer under a scope has it (work threads, replies, diagram and artifact
  threads, the task comment bar). It draws only person tokens as chips
  (`referenceKinds`); `@name` and `/word` stay prose. The work body uses a
  Tiptap extension (`mentions/lib/tiptap-mention-picker.ts`).
- **Agents.** `read_work` and `read_task` show `@Name`. Agents do not create
  mentions. A task comment posted upstream (`sync-engine.ts`) goes as `@Name`;
  the stored comment keeps the id.

**Step 17 — access warning.** `personCanOpen` (`mentions/lib/mentions.ts`)
follows `ShareManager.roleFor` on the client: the owner, a row for the person,
a row for a team they are in, the organization row for a member, and the lists
of the tasks the record inherits from. A link does not count. With a list or
the directory not loaded, the answer is unknown and nothing is shown.
`MentionAccessNotice` says "<name> cannot open this" with Share (the existing
share dialog, when `canShareFrom`). The mention is saved either way. In a
comment it checks every mention in the draft; in a work body, the people
mentioned in this editing session.

Known limits:

- A work body renders a chip once; a directory that loads later shows the new
  name at the next render.
- `update_work` turns each `@Name` back into the mention the previous version
  held (`restoreMentions`, `contracts/src/mentions.ts`). A name that two people
  share stays text, and an agent still makes no new mention. An update that goes
  to a task's host as an outbox op has no previous version here, so it keeps
  the text.
- Comments in the rich task description, plans and pull request reviews take
  no mentions (not organization records in D17).

Tests: `mentions` (the token round-trips through Markdown; the body chip
writes the same Markdown and shows the current name, and a person who left has
no chip; comment text keeps the user id; a Local record offers no people and
opens no menu; ranking and query; Enter inserts the member's id; the warning
only for a person with no role, including team, organization and inherited
task rows; unknown shows nothing), `work-mentions-read` (`read_work` renders
`@Name` for body and thread), `task-sync-engine` (upstream gets `@Name`, the
stored comment keeps the token). Related suites pass: `reference-tokens`,
`reference-token-icons`, `comment-text`, `github-markdown`,
`unified-autocomplete`, `artifact-work`, `comment-tools`.

Checks run: `tsc` for `packages/workspace-ui`, `packages/server` and
`packages/contracts`, and `svelte-check` for `packages/workspace-ui`, show no
error in the changed files. `oxlint` shows only findings that were there
before. `lint:layout` and `lint:surfaces` are clean.

Not exercised: no dev server or browser run, so there is no visual check of
the picker and the notice on desktop, web or phone width.

### Stage 4 (steps 10, 11 and 12) (2026-09-29)

The rules of the conversation-view work apply to each row: the host names the
person, "you" only for the reader's own ids, no name when only the reader acts
or when the reader is not yet known, no name after a reload (D13). The label
helpers are in `components/presence/lib/actor-name.ts` (`otherPerson`,
`needsLabel`, `waitingOnLabel`, `callTitle`, `steerPlaceholder`, `limitTitle`).
Inside cards and dividers a person is `presence/PersonName.svelte`: avatar and
first name in the presence colour.

**Step 10.**

- **F2.** `turnAuthor` is on `permission_request`, `question_request` and
  `rate_limit`. `SessionRuntime._stampTurnAuthor` stamps it before delivery
  from the running turn's actor. The pending copy is the same object, so the
  `pending_input_sync` replay also names the author. The client keeps it on
  `PermissionRequest`, `QuestionRequest` and `RateLimitInfo`.
- **F4.** `permission_resolved.decision` is `approved`, `approved_for_session`
  or `denied`, read from the option's kind (`permissionDecisionFor`). Claude
  sends no resolution, so the host now sends `permission_resolved` with `by`
  and `decision` when a person answers a Claude permission. For Codex, the
  host adds both to the provider's later resolution.
- **Live notices.** A new `Message.personNotice` row ("Bob approved Bash for
  this session") is written by `pushPersonNotice`
  (`contexts/workspace/person-notices.ts`) only for a person other than the
  reader. The reducer reads the reader's ids through a new
  `selfUserIds` dependency. A Codex permission whose card left before the
  provider's resolution reads "a permission request".
- **Done:** "Needs Alice" (breadcrumb status of the open session), the question
  card title and chip, "Alice's turn asks to …" on the permission card, the
  approval or denial notice, the answerer's face on the answered question,
  "plan rejected by Bob", "Alice's seat reached the … limit", the stop /
  send-now notice of a rate-limit decision, and "Bob removed your held prompt"
  / "Bob edited Cara's held prompt" (only when the person changed someone
  else's prompt).
- **Not done: "plan accepted by Bob".** Acceptance is a client action (stop,
  reset, new prompt); no host fact says who accepted, except through a Claude
  or Codex `allow`, which now names the person. A host plan-decision RPC is
  needed for the rest.
- **Not done: the rate-limit "Queue prompt" choice.** `wait` sends no
  `rate_limit_resolved`, so no notice names who queued.
- **Skipped: F5** (orchestration exchanges), which waits on P7 item 1.

**Step 11.**

- **Composer.** While a teammate's turn runs, the placeholder is "Enter to
  steer Alice's turn · ⌥Enter to queue next" ("Send to steer Alice's turn…"
  without a keyboard). It reads `activeTurn` from the session room.
- **Live turn row.** The rail says "for [avatar] Alice" when the turn is a
  teammate's.
- **Organization refusal card.** `connections/TurnRefusalCard.svelte`, near the
  seat card. The client-local `turnRefusalStore` holds the refusal code and
  the host's message; only the refused client has it. Per code
  (`connections/lib/turn-refusal-copy.ts`) the card names the organization and
  offers "Work in {organization}" or "Sign in" (desktop only; a browser shows
  the hint). A later accepted send or Escape removes the card.

**Step 12.**

- **Rename.** `SessionTitleChangedEvent.by` for a manual rename. A teammate's
  rename writes "Bob renamed this session".
- **Share.** `ShareChangedEvent.organizationSharedBy` is set when a change adds
  an organization grant. The open conversation writes "Bob shared this session
  with the organization".
- **Seat.** A refused prompt sends `seat_needed` (provider, `by`) to everyone
  in the room except the refused client. They read "Bob needs to connect a
  Claude seat on this host".
- **Mobile header.** `SessionPresence` and `ShareButton` are in the phone
  header. Both stay absent when the reader is alone or the host cannot share.
- **Skipped: the four dividers** (fork, move to a worktree, agent handoff, new
  session from a plan). The client that acts writes each divider for itself;
  the host sends no event, so a teammate never sees it and the actor would read
  "you". Each needs a host event with `by`; the handoff event is not small
  (`switchActiveAgent` and the lineage reader), so it is left for later.
- **Skipped:** F1 and F6 (D13), the finished-turn and diff-summary rows, and
  commit and push notices (step 8 owns git).

**Tests.** `session-event-acted-by` (the reducer keeps `turnAuthor`, the
decision and the notices; none for the reader or an unknown reader),
`conversation-people-labels` (the label helpers, the refusal copy, the rename
notice), `session-runtime-queue-author` (the host stamps `turnAuthor` and the
decision; `seat_needed` skips the refused client). The related suites pass;
`session-runtime-seats` (2) and `seat-manager` (1) fail as before on the test
database (`duplicate column name: pr_state`) and a login fixture. `tsc` and
`svelte-check` show no error in the changed files; `oxlint` shows only the
complexity findings that were there before; `lint:layout` and `lint:surfaces`
are clean.

Not exercised: no dev server or browser run, so there is no visual check on
desktop, web or phone width.
