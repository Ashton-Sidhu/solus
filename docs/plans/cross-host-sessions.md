# Cross-host sessions — `start_session` on another host

Status: proposed (2026-10-06). Not implemented.

## 1. Goal

An agent on host A can call `start_session` with `host: B`. The session starts
on host B **as if the user started it on host B**. Host B applies its usual
admission, access policy, and attribution. Host B has no new trust rule.

The parent session on host A gets the same exchange behavior as a local child:
the card, the report, notices, `wait_seconds`, `request_id` retries,
`send_session`, `stop_session`, and `read_session_exchange`.

## 2. Vocabulary

- **parent host** — the host that runs the session that calls `start_session`
  (host A).
- **target host** — the host the new session runs on (host B).
- **host dispatch** — the steps that make a target host ready and start work
  there: start a stopped Cloud host, connect, prepare the checkout, create the
  session. Today the Run on picker does these steps in the client.
- **host delegation** — a refreshable credential that a parent host holds to
  act for one person on one target host. It extends the organization
  delegation in `sync/delegations.ts`.
- **remote exchange** — an exchange in the parent host's `ExchangeLedger`
  whose target session is on a target host.

Do not use "peer host", "remote spawn", or "cross-machine session" for these
concepts.

## 3. What exists today

- **Run on picker.** The client does all of the host dispatch on its own
  connection (`workspace-ui/src/contexts/workspace/prompt-dispatch.ts`):
  `serversStore.startManagedHost`, `serverConnections.ensure(B)`,
  `prepareHostCheckout` (`components/servers/run-on.ts:253`), then
  `moveTabToHost` and send. The parent host takes no part. This is correct for
  a person: the client holds the person's token for host B.
- **Host tokens.** A host token has one audience, `hostAudience(hostId)`
  (`packages/lab/src/issuer.ts:371`). Host B refuses a token for another host
  with `wrong-audience` (`admission/access-tokens.ts:116`). Host A has no
  token that host B accepts.
- **Account access in the client.** `UplinkAccountSource`
  (`client-core/src/uplink-session.ts`) reads the host directory and mints a
  grant for one host. The account credential stays in the Electron main
  process or the web cookie. A server has neither.
- **Delegations.** `sync/delegations.ts` exchanges a person's token for a
  refresh token that this host keeps (RFC 8693), and refreshes it. It is keyed
  by person and organization, and the only resource is the Solus API.
- **Session start on a host.** `createHeadlessSession`
  (`transport/handlers/session-handlers.ts:309`) creates a session with no tab
  and claims it for the caller's principal.
- **Exchanges.** `SessionOrchestrator.spawn`
  (`execution/orchestration/session-orchestrator.ts:241`) calls
  `runtime.createSession` on the same host. The ledger and its run hooks are
  in-process only.

## 4. Decisions

1. **Auth is the user's.** The parent host acts for the person attributed to
   the calling turn (`execution/sessions/turn-organization.ts`). For a Local
   desktop session, that is the owner. Host B sees a normal user token.
2. **The parent host gets the token by token exchange.** It does not reuse a
   client's token and it does not ask a client to do the create. Both of those
   fail when no client is open (automations, a closed laptop, a headless
   server).
3. **One host dispatch, in `client-core`.** The picker, the mobile app, and the
   server call the same code. Only the connection and its token differ.
4. **The parent host owns the remote exchange.** Host B does not know that an
   exchange exists. Host A subscribes to the child session's events on host B,
   the same way a mounted client does, and settles the exchange from them.
5. **No relay.** Host A connects to host B on the route a client uses (direct
   or through B's uplink). The cloud only issues tokens.

## 5. Design

### 5.1 Host dispatch in `client-core`

Move these steps out of `workspace-ui` into
`packages/client-core/src/host-dispatch.ts`:

- wait for a managed host to start (the polling now in
  `servers.store.svelte.ts:511`),
- `prepareHostCheckout` and `cloneUrlForRepoKey`,
- a `dispatchSession(target, request)` that prepares the checkout and calls
  `createHeadlessSession`.

The module takes its inputs as arguments: a `HostApi` for the target, an
`UplinkAccountSource`-shaped port for managed-host start, and an optional
GitHub credential. It imports no Svelte and no Electron.

The picker keeps its status card and tab move in `prompt-dispatch.ts` and
calls the shared steps. The mobile app calls them instead of keeping its own
copy. This step changes no behavior.

### 5.2 Host delegation

Extend `Delegations` so that the resource is a target host:

- Key: person, organization (`local` for Local work), and target host id.
- Exchange request: add `resource: hostAudience(B)`. The scopes are the scopes
  of a first-party client token for that host.
- `accessToken(userId, organizationId, hostId)` returns a current token, the
  same as today.
- A refusal from the account plane ends only the delegation for that host. It
  does not stop the person's work on host A.

Account plane (solus-cloud) changes:

- Accept a token exchange whose `resource` is another host's audience.
- Issue it only when the subject person can reach that host now: they own it,
  or it is shared with them in that organization. Apply the organization's
  allowed-host policy.
- Allow an exchange with no organization for the person's own hosts (Local
  work). Today `organization_id` is required (`issuer.ts:84`). Update the lab
  issuer to match, so tests can cover it.

The first exchange needs a current subject token for host A
(`deps.personToken`). If there is none, `start_session` fails with
"Reconnect to this host and try again." It does not wait.

### 5.3 Host directory on the server

The parent host must know which hosts the person can reach, with a route to
each. Add a server-side read of the account plane's directory for the person,
authorized by the host's OAuth client and the person's delegation. Cache it
for a short time; a host that is not in the directory is refused.

### 5.4 Tool surface

- `list_agent_targets` gets an optional `host`. With it, the parent host asks
  host B for its agent targets over the host connection. Without it, nothing
  changes. Add a `list_hosts` answer to the same tool or a new tool, which
  lists hosts by label, id, and online state. Decide in step 3.
- `start_session` gets an optional `host` (id or label). With it:
  - `chooseRunner` validates the provider and model against host B's targets.
  - `cwd` is a path on host B. `~` is resolved on host B, not on host A.
  - `worktree_base_branch` is sent to host B's checkout preparation.
  - `task='attempt'` is allowed only when the task's record home can be read
    on host B (an organization task). For a Local task, fail with a clear
    error. A remote session does not create a second task.
- `sessionLink` already carries `serverId`. Every receipt for a remote session
  includes it, so the card and links open the session on host B.

### 5.5 Remote exchanges

`SessionOrchestrator.spawn` gets a target host. For a remote target:

1. Open the exchange in the ledger as today, with `targetHostId` set. The
   card shows at once with the host label.
2. Run host dispatch (5.1) with a connection authorized by the host
   delegation (5.2).
3. Bind the exchange to the session id that host B returns.
4. Subscribe to that session's events on host B. Map them to the existing
   hooks:
   - `status_change` to idle or error, with the final assistant reply →
     settle and report.
   - pending permission, question, or plan → notice to the parent.
   - rate limit → notice.
5. Close the subscription when the exchange settles.

`send_session`, `stop_session`, and `read_session_exchange` read
`targetHostId` from the ledger and call the matching RPC on host B.

`request_id` identity stays on host A. A retry returns the original exchange
and does not dispatch again.

### 5.6 Recovery

- **Host A restarts.** `recoverExchanges` reopens each open remote exchange,
  reads the child session's state from host B, settles it if it ended, and
  subscribes again if it did not. It never starts the session again.
- **Connection to host B drops.** The exchange stays open. The parent card
  shows "Host B is not reachable" until the connection returns. After the
  ledger's existing interrupt limit, the exchange settles as interrupted,
  with the child session link so the user can open it on host B.
- **Host B restarts.** Host B's own restart recovery applies to the child
  session. Host A sees the result through the subscription.

## 6. Surfaces

- **Clients.** The orchestration card shows the target host label on desktop,
  web, and mobile. Opening the child session from the card goes to host B on
  every client. The Run on picker behavior does not change.
- **Providers.** Claude and Codex both use `start_session`. Remote target
  support is the same for both. A provider that is not available on host B
  gives host B's own unavailable reason.
- **Connection modes.** Desktop-local, desktop-hosted, and standalone hosts can
  all be a parent host or a target host. The parent host uses B's route from
  the directory and never a client's local path or origin.
- **Reverse states.** Stop, send, and read work on a remote child. A revoked
  delegation shows as an error on the next call, not as a silent failure.
- **Docs.** Update `docs/` for `start_session` and the orchestration card.

## 7. Order of work

| Step | Change | Effort |
|---|---|---|
| 1 | Move host dispatch into `client-core`. Picker and mobile call it. No behavior change. | 2–3 days |
| 2 | Host delegation in `sync/delegations.ts`, and the account-plane exchange in solus-cloud and the lab issuer | 2–3 days |
| 3 | Server-side host directory; `host` on `list_agent_targets` | 2 days |
| 4 | `host` on `start_session`, fire-and-forget (`report=false`) | 1–2 days |
| 5 | Remote exchanges: card, report, notices, wait, send, stop, read | ~1 week |
| 6 | Recovery after a restart or a dropped connection | 2–4 days |

Steps 1 and 2 can run in parallel. Each step ships alone.

## 8. Tests

- Step 1: the existing picker dispatch tests pass without change; new tests
  call `host-dispatch.ts` with a fake `HostApi`.
- Step 2: delegation tests against the lab issuer: a host the person can reach
  gets a token for its audience; a host they cannot reach is refused; a
  refused refresh ends only that host's delegation.
- Steps 4–6: orchestrator tests with two in-process hosts and a fake
  transport: start, report on turn end, notice on a pending question, a retry
  with the same `request_id`, a parent restart with an open exchange, and a
  dropped connection.

## 9. Open questions

1. Does the account plane allow a host's OAuth client to exchange for another
   host's audience? This is a solus-cloud product and security decision.
2. Should host B show that a session was started by an agent on host A? The
   proposal attributes it to the person only, the same as a human start.
3. Should a Local task be allowed to own a session on another host (for
   example, by publishing the task first)? The proposal refuses it.
