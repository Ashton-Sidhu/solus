# Cross-host sessions — `start_session` on another host

Status: first version implemented (2026-10-06): §4 decisions 1–7, §5.1–§5.5. §6 lists what it does not do yet.

## 1. Goal

An agent on host A can call `start_session` with `host: B`. The session starts
on host B **as if the user started it on host B**. Host B applies its usual
admission, access policy, and attribution. Host B has no new trust rule.

The parent session on host A gets the same exchange behavior as a local child:
the card, the report, notices, `wait_seconds`, `request_id` retries, and
`read_session_exchange`.

This changes one earlier rule. `PromptOptions.taskSnapshot` says "hosts never
talk to each other". After this plan, a host talks to another host as a client
does, with the user's own token. It still never trusts another host.

## 2. Vocabulary

- **parent host** — the host that runs the session that calls `start_session`
  (host A).
- **target host** — the host the new session runs on (host B).
- **host access** — what the parent host needs from the user's account: the
  list of hosts the user can reach, and a short-lived token for one of them.
- **remote exchange** — an exchange in the parent host's `ExchangeLedger`
  whose target session is on a target host.
- **session origin** — the agent session on another host that started a
  session. Host B stores it and shows "Started by an agent on <host>".

Do not use "peer host", "remote spawn", or "cross-machine session" for these
concepts.

## 3. What exists today

- **Run on picker.** The client does all of the work on its own connection
  (`workspace-ui/src/contexts/workspace/prompt-dispatch.ts`): start a stopped
  Cloud host, connect, `prepareHostCheckout`, move the tab, send. The parent
  host takes no part. This stays correct for a person.
- **Host tokens.** A host token has one audience, `hostAudience(hostId)`.
  Host B refuses a token for another host (`admission/access-tokens.ts`).
- **The account session on desktop.** The desktop main process holds the
  user's account session. It already gives the server
  `ownerAccessToken(hostId)` (`boot-server.ts`), which calls the account plane's
  `POST /v1/hosts/:hostId/access-token`. That endpoint checks that the user can
  reach the host, then mints a five-minute token for it.
- **Session start on a host.** `createHeadlessSession`
  (`transport/handlers/session-handlers.ts`) creates a session with no tab and
  claims it for the caller. The caller may choose the session id.
- **Exchanges.** `SessionOrchestrator` is driven by run hooks (`runStarted`,
  `inputRequested`, `inputResolved`, `runEvent`, `runSettled`) that the local
  runtime calls.

## 4. Decisions

1. **Auth is the user's, from the account session the host already has.**
   Host A asks the account plane for a token for host B with the user's
   account session (`ownerAccessToken`). The account plane already checks that
   the user may reach host B. No token exchange and no account-plane change.
   Being signed in to Solus and allowed on host B is enough.
2. **Only a host with an account session can start work on another host.**
   Today that is the desktop app. A standalone or managed host has no account
   session, so `host` on `start_session` answers "not available on this host".
3. **Host B shows the origin.** A session that an agent on another host
   started shows "Started by an agent on <host A>" on every client.
4. **No task across hosts.** `task='attempt'` with `host` is refused. A Local
   task lives on host A only. Organization tasks across hosts are a later step.
5. **The parent host owns the remote exchange.** Host B does not know that an
   exchange exists. Host A watches the child session on host B, the same way a
   client does, and feeds host B's events into the same run hooks a local
   child uses. All card, report, notice, and wait behavior is shared.
6. **Host A chooses the child's session id and watches it first.** Then it
   creates the session. A child that ends at once cannot finish before host A
   listens.
7. **No relay.** Host A connects to host B on a route from the directory, with
   `client-core`'s `WsTransport` and `HostSupervisor`. The cloud only issues
   tokens.

## 5. Design

### 5.1 Host access

`bootCore` takes `ownerHosts()` beside `ownerAccessToken(hostId)`. The desktop
wires both from its account session (`GET /v1/hosts` and
`POST /v1/hosts/:hostId/access-token`). A host without them has no host access.

### 5.2 Remote host connections

`execution/orchestration/remote-hosts.ts` keeps one connection per target
host: a `WsTransport` whose `acquireGrant` is `ownerAccessToken(B)`, driven by
a `HostSupervisor`. It prefers a `direct` route, then `tunnel`. A host is found
by id or by label (case does not matter). A host that is not in the directory
is refused.

### 5.3 Tool surface

- `list_agent_targets` gets an optional `host`. With it, the answer is host
  B's own targets (`listAgentTargets` on B). Without it, the answer also lists
  the hosts this host can start work on, when it has host access.
- `start_session` gets an optional `host` (id or label). With it:
  - the provider and model are checked against host B's targets,
  - `cwd` is a path on host B. When it is absent, the session starts in a new
    chat folder on host B,
  - `worktree_base_branch` is sent to host B,
  - `task` must be `'none'`.
- Receipts and cards carry host B's label.

### 5.4 Remote exchanges

For a remote target, `SessionOrchestrator.spawn`:

1. chooses the session id and opens the exchange with `targetHostId`,
2. watches the session on host B (`watchSession`) and subscribes to
   `session.eventReceived` and `session.statusChanged` for it,
3. calls `createHeadlessSession` on host B with the session id and the origin,
4. maps host B's events to the run hooks:
   - status `running` → `runStarted`,
   - `permission_request`, `question_request`, `plan` → `inputRequested`,
   - `permission_resolved`, `question_answered` → `inputResolved`,
   - `work_created`, `artifact_created`, `plan` → `runEvent`,
   - `task_complete` → the reply and duration,
   - `turn_settled` → `runSettled`, then the watch ends.

`stop_session` on a remote child calls `stopSession` on host B.
`read_session_exchange` reads the ledger on host A and needs no change.

### 5.5 Session origin

`HeadlessSessionRequest` and `SessionMeta` get `startedBy: { hostLabel,
sessionId }`. Host B stores it on the thread's first row in its session index
(`sessions.started_by`), and every client shows it at the top of the
conversation.

## 6. Not in the first version

- Rate-limit notices from a remote child.
- Recovery: after host A restarts, an open remote exchange settles as
  interrupted, like an uncertain local child. Reattaching is a later step.
- Cloning a repository on host B before the start. `cwd` must already exist
  on host B. Sharing the picker's host dispatch through `client-core` is the
  later step that adds it.

## 7. Surfaces

- **Clients.** The origin line shows on desktop, web, and mobile. The parent's
  card shows the target host label. The Run on picker does not change.
- **Providers.** Claude and Codex both call `start_session`. Both get the same
  behavior.
- **Connection modes.** A desktop host can be a parent host. Any host can be a
  target host.
- **Reverse states.** Stop works on a remote child. A refused token shows as
  an error on the call.

## 8. Tests

- Unit: the event mapping from host B's events to the run hooks, host lookup by
  id and label, the tool's refusals (`task='attempt'`, no host access, unknown
  host).
- End to end: host B is a real server from source, linked to the Lab issuer.
  Host A boots in the test process with `ownerAccessToken` minted by the Lab
  issuer. A parent session on host A (mock backend) calls `start_session` with
  `host: B`. The test checks that host B admits the token, the child runs on
  host B with its origin, and the report reaches the parent on host A.

The end-to-end proof is a test-only script outside the repository, because
the Lab harness boots the built server and the build is the developer's to
run. It ran host B from source under `node` with tsx and the mock backend
alias, linked to the Lab issuer, and host A in the test process. Both passed:
start and report (10 checks) and stop (4 checks). The mock backend gives every
session one provider thread id, so each scenario needs fresh hosts.

## 9. Step 2: host trust (proposed 2026-10-07)

### 9.1 Why

The first version needs the owner's account session, so only the desktop app
can start work on another host. A standalone server or a Cloud host cannot.
Step 2 lets the owner trust two hosts with each other. Then an agent on either
host can start sessions on the other, as the owner, with no account session.

### 9.2 Vocabulary

- **host trust** — the owner's record that two hosts may start sessions on
  each other. It is symmetric: one record, both directions. "Link" and "pair"
  are not used for it: `host_link` is a host's enrollment with the cloud, and
  pairing is a client's credential for a host.
- **trusted host** — a host in a host trust with this host.

### 9.3 Decisions

1. **The account plane keeps the record and mints the tokens.** A host never
   trusts another host directly. Host A verifies the same kind of token as
   from a client, so host A has no new trust rule.
2. **A host trust acts for the person who made it.** The token is for that
   person, and the account plane checks at every mint that the person can still
   reach the target host (owner, or a member with the organization's host
   policy). On the requesting host, only that person's turns, or the host's own
   work, may use it. A member's turn on a shared Cloud host does not borrow the
   owner's trust.
3. **Both hosts must be enrolled with the cloud** (`host_link` linked). A host
   without a tunnel route cannot be a target.
4. **A desktop with an account session keeps using it.** It already reaches
   every host its owner can. Host trust is the path for a host with no account
   session. Both are behind the same `HostAccess` port (§5.1).
5. **Removal takes effect at the next mint**, within one token life (five
   minutes). Open sessions on the target are not stopped; their reports stop
   arriving when the token can no longer be renewed.

### 9.4 Account plane (solus-cloud)

- Table `host_trust(host_id_low, host_id_high, created_by_user_id, created_at)`,
  primary key on the ordered pair, cascade on either host's deletion.
- `GET /v1/hosts/:hostId/trusts` (account session): the trusted hosts.
- `POST /v1/hosts/:hostId/trusts {hostId}` (account session): the caller must
  be able to reach both hosts.
- `DELETE /v1/hosts/:hostId/trusts/:otherHostId` (account session).
- `GET /v1/hosts/:hostId/trusted-hosts` (host token): the trusted hosts as
  `DirectoryHost` rows, with routes. It is `HostAccess.hosts()` on a server.
- `POST /v1/hosts/:hostId/trusted-hosts/:targetHostId/access-token` (host
  token): a five-minute token for the target host, for the trust's person,
  with the same claims `issueHostAccessToken` builds for that person.
- The console's host page lists the host's trusts, with add and remove.

### 9.5 Solus

- `HostAccess` gets a second implementation on the host token
  (`uplinkManager.hostToken()`), wired in `boot-server.ts` when there is no
  account session. `remoteHostsFor` picks the account session first.
- `actsForHostOwner` becomes "acts for the person this host access is for":
  the owner on desktop, the trust's person on a server.
- `UplinkAccountSource` gets `listHostTrusts`, `addHostTrust`, and
  `removeHostTrust`. Desktop main, the web cookie source, and mobile implement
  them.
- Settings → Hosts on desktop and web, and the host screen on mobile, show
  "Trusted hosts" with add and remove. A host that is not enrolled shows why it
  cannot be added.

### 9.6 Order of work

| Step | Change | Effort |
|---|---|---|
| 1 | solus-cloud: table, routes, mint, Lab issuer equivalents | 2–3 days |
| 2 | Solus: host-token `HostAccess`, person check, wiring | 1–2 days |
| 3 | Client account sources and the trusted-hosts UI on desktop, web, mobile | 2–3 days |
| 4 | Tests: unit, Lab issuer scenario with a standalone host A and B both ways | 1–2 days |

About 1.5–2 weeks in total.
