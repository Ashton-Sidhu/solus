# Add a machine from the conversation

Status on 2026-11-24: implemented on the host, desktop, web, mobile, and the
CLI, with focused tests. Not yet run end to end on two machines or on a phone.
Approved decisions: one click for SSH (including the install), the approve flow
is in scope, and `pair_host` is replaced.

## Problem

A person asked an agent to link this Mac to a Windows machine at `10.10.1.10`.
The agent showed the generic `request_secret` card ("Paste the secret"). The
card did not say what to enter or where to get it. The person entered their
Windows password. `pair_host` sent it to the remote host over plain HTTP, and
the host refused it with the same message as every other failure. The Mac
already had a working SSH key for that machine (`solus-windows` in
`~/.ssh/config`), so no code was necessary.

T3 Code has the same base flow (a 5-minute code, typed into a plain field, no
format check, one combined error). It is better in three places: its card
ranks the person's machines against the agent's hint, it makes the code itself
when the client can reach the target, and it has one-click device approval for
T3 Connect. It does not offer SSH from the card, it does not link to the code,
and a wrong code closes its card.

## Vocabulary

Lock these names. Do not add synonyms.

- **Add machine** — the user-visible name of the act, on the card, the Add page,
  and in docs. The agent tool is `add_host`.
- **Add machine card** — the conversation card that `add_host` shows. Its
  question kind is `host-link`.
- **Way** — how a machine is added: `ssh`, `approve`, or `code`. The client can
  make a code for a host it reaches as owner; that is the `code` way with a
  minted code, not a fourth way.
- **Candidate** — one machine the card offers, with its best way.
- **Pairing code** — the 6-digit code (or pair link) that a host makes.
- **Approval request** — a request that a machine sends to a host to be paired
  without a code. The host's owner approves or denies it.
- **Check code** — the 8-character code (`K7QM-2XFD`) that an approval request
  shows on both machines, so the person can compare them.

## Rules

1. A code or password never goes to a host before its shape is checked. A
   pairing code is 6 digits or a pair link (`classifyPairSecret`).
2. The card picks the way that needs no typing first: a minted code, then SSH,
   then an approval request, then a typed code.
3. A failure that the person can fix keeps the card open. Decline or a stopped
   run closes it.
4. A secret (a code, an SSH password) goes to the host once, in the existing
   RPC that uses it (`hostsPair`, `hostsAddOverSsh`). It is never in the
   transcript, a draft, the card's answer, tool input, or tool output.
8. Reuse before adding. The card does its work with RPCs that exist. A new
   RPC or topic is only for a capability that does not exist: approval
   requests.
5. The new host's name is the name it reports, unless the person changes it.
6. Only a locally authorized owner session can call `add_host`. Only a
   principal with `host.local.reach` can list or decide approval requests.
7. Desktop, web, and mobile expose the same card, the same approval notice,
   and the same link to the pairing code.

## Flow

```text
agent → add_host { hint?, url?, reason }
host  → already reaches a matching host? → return it, no card
host  → question_request kind 'host-link' (hostLink: ask)
client: ranks candidates (client-core rankAddMachineCandidates)
  sources: this client's hosts (mint), the session host's SSH config
           (hostsListSshConfigHosts, with hostName), nearby machines, ask.url
person picks a candidate; the client calls the session host's existing RPCs:
  ssh     → hostsAddOverSsh { sshTarget } (install, start, forward);
            progress on host.sshProgress; needs-auth asks for a password
  approve → client makes a check code and shows it, then
            hostsPair { url, checkCode }: the host sends POST /pair/request
            to the target and resolves when the owner approves
  code    → hostsPair { url, code } (typed, or minted by the client with
            connectionsGeneratePairToken on the target)
a failed call shows its error on the card; the card stays open
success → respondQuestion with addMachineOutcomeAnswers({ added, installationId })
          → add_host (answerToolQuestionWith) checks the host record, returns
decline → respondQuestion with { declined }
```

### The card

- Title: "Add a machine". The agent's reason below it.
- A candidate list. Each row shows the machine's mark (its operating system,
  or a terminal for an SSH target), the name, its address or SSH alias, and its
  way: "From this device", "Over SSH", "Ask it to approve", "Needs a code".
  The best match is selected, and a first row that matches the agent's ask
  shows "Best match". "Another address…" is always last. The rows have no
  status dots.
- One primary button for the selected way: **Add <name>**, or **Ask to
  approve**. The key hints show while the pointer or focus is on the card.
- After Add, the card is the setup card that a run's setup draws
  (`StatusCard`), with the steps from `addMachineStatusCard` in client-core, on
  every client. SSH shows each step that the host reports on
  `host.sshProgress`, with the install percentage. A pairing is one host call,
  so its steps are only what the client knows: it waits on the target, then it
  is connected.
- `approve`: the check code shows under the waiting step, with "Approve it in
  Solus on <name>, or run `solus host approve <check code>` there" (the command
  shows as code) and the time left.
- `code` (typed): a 6-digit field (pair links also paste), with steps that
  name the target: "On <name>, open Settings → Connections → This computer →
  Access → Generate code, or run `solus pair`". When this client reaches the
  target, a link opens that host's Access tab with a code already made.
- SSH `ssh-needs-auth`: the step that SSH stopped on shows a warning with the
  reason, and a password field appears on the card.
- A failed add shows its setup card above the choice: the step it stopped on
  is red, with the reason. A value refused before anything is sent shows its
  message at the field. **Try again** keeps the card. Another machine or way
  removes the old setup card.
- An answered card leaves the conversation. The tool output does not reach the
  client, so no line stays in the conversation; a toast tells the person.
- **Decline** closes the card and tells the agent.

### The approval request

```text
requester (host H)                      target (host T)
POST /pair/request                →     pending request: id, check code,
  {deviceLabel, checkCode}              address, label, expiresAt (5 min)
                                  ←     {requestId, expiresAt, waitToken}
POST /pair/request/wait           →     long poll, at most 25 s per call
  {requestId, waitToken}                owner clients get host.pairApprovalsChanged
                                        and show Approve / Deny with the check code
                                  ←     pending | denied | expired |
                                        approved {sessionToken, installationId,
                                                  os, identityKey}
```

- The endpoint has the same exposure as `/pair`: absent on a managed host and
  over the tunnel, rate limited per address. At most 5 open requests per
  host; a sixth is refused with 429.
- The requester makes the check code (an unambiguous alphabet: no `0`, `O`,
  `1`, `I`), so the card shows it before the call returns and needs no
  progress event. A machine on the network that sends its own requests cannot
  know the code on the person's screen.
- Approving issues a session token exactly as `/pair` does, labeled with the
  requester's device label, and listed and revocable with the other devices.
- `waitToken` is a random secret that only the requester knows, so another
  machine on the network cannot collect the token.
- Desktop and web show a toast with **Approve**, **Deny**, and **Review**
  (Review opens Settings → Connections → this host → Access, where a list of
  open requests is). Mobile shows the same notice and list.
- The CLI: `solus host approvals`, `solus host approve <check-code>`,
  `solus host deny <check-code>`.
- The Add page's "Pair with a code" form also offers **Ask it to approve**, so
  a client can use the same flow without an agent.

## Contracts (this change's seam; written first)

Reused, unchanged: `hostsAddOverSsh` with `host.sshProgress`,
`hostsListSshConfigHosts`, `connectionsGeneratePairToken`, `respondQuestion`
with the server's `answerToolQuestionWith`.

Changed:

- `hostsPair` (`hostPairRequestSchema`): `code` is optional, and `checkCode`
  is new. Exactly one of them.
- `SshTargetCandidate.hostName?: string`, the resolved address, so
  `10.10.1.10` matches `solus-windows`.
- `QuestionRequest.kind` and the `question_request` event: `host-link`, with
  `hostLink: AddMachineAsk`.

New, because approval requests do not exist today:

- `hostsPairApprovals(): Promise<PairApprovalRequest[]>` and
  `hostsPairApprovalDecide(requestId, decision): Promise<boolean>`, both
  `host.local.reach`.
- `host.pairApprovalsChanged: { approvals }`, only to principals with
  `host.local.reach`. The notifications hub keeps durable records for each
  recipient; a 5-minute request that lives in memory does not fit it.
- HTTP `POST /pair/request` and `POST /pair/request/wait` on the target.

`packages/contracts/src/add-machine.ts`: `AddMachineAsk`, `AddMachineWay`,
`AddMachineOutcome` with `addMachineOutcomeAnswers` and
`readAddMachineOutcome`, the approval types, and the check code helpers.

`packages/client-core/src/pairing.ts`: `classifyPairSecret(value)`, and
`requestPairApproval(input)` for the requester side (used by `HostPairings`
for `hostsPair { checkCode }`, and by the Add page on a client).

`packages/client-core/src/add-machine-candidates.ts`:
`rankAddMachineCandidates(ask, sources)`, one order for desktop, web, and
mobile.

## Work and file ownership

Each part owns its files. A part does not edit another part's files.

### A. Server: `add_host`

- `packages/server/src/execution/agents/tools/host-pairing-tools.ts`: replace
  `pair_host` with `add_host`; keep `remove_host`. Update
  `packages/contracts/src/agent-tools.ts` names and `session-tools.ts` and
  `orchestration/remote-hosts.ts` references.
- `add_host` emits the `host-link` card and waits with
  `answerToolQuestionWith` (as `session-folder-attach.ts` does). It reads the
  answer with `readAddMachineOutcome` and checks that the host record exists.
- `packages/server/src/host/host-pairings.ts`: the shape check
  (`classifyPairSecret`) before any request, `label` defaults to the reported
  name, and `checkCode` pairing through `requestPairApproval`.
- `hostName` on SSH config candidates.
- Docs: `docs/host-pairing.md`, `docs/solus-tools.md`,
  `docs/host-connection-troubleshooting.md`.
- Tests: shape check refuses a password with no request sent; no secret in
  tool output; label default; an already-reached host returns with no card;
  a forged `added` answer for an unknown host is refused.

### B. Server: the approval request

- `packages/server/src/admission/pair-approvals.ts`: the open requests, check
  codes, expiry, the cap, and `waitToken` checks.
- `packages/server/src/transport/http.ts`: `POST /pair/request` and
  `POST /pair/request/wait`.
- Handlers for `hostsPairApprovals` and `hostsPairApprovalDecide`; the
  `host.pairApprovalsChanged` broadcast, scoped to `host.local.reach`.
- `packages/client-core/src/pairing.ts`: `requestPairApproval`.
- `apps/cli/src/lib/hosts.ts` and `index.ts`: `approvals`, `approve`, `deny`.
- Tests: approve, deny, expiry, the cap, a wrong `waitToken`, a managed host
  and the tunnel have no endpoint, the token is listed and revocable.

### C. Desktop and web (`packages/workspace-ui`)

- `components/conversation/AddMachineCard.svelte` and
  `components/conversation/lib/add-machine-card.ts`; route the `host-link`
  kind in `TranscriptItem.svelte` and the agent request card list.
- The link to the code: the `connections` resource route takes `tab` and
  `pair`; `connectionsNav.open(id, 'access')`; `PairCodePanel` makes the code
  when asked. A command palette entry, **Show pairing code**.
- The approval notice (toast with Approve, Deny, Review) and an "Approval
  requests" section in `HostDetailAccess.svelte`, through a store.
- `fleet/AddPairMachine.svelte`: **Ask it to approve**.
- Tests for the card's lib and the store.

### D. Mobile (`apps/mobile`)

- The Add machine card: adapt the upstream T3 `LinkRequestCard.tsx` to the
  `host-link` kind through `conversation-feed.ts` and `RequestCards.tsx`, using
  `rankAddMachineCandidates` and the Solus host API.
- The approval notice and the approval list on the host access screen.
- The link to the code on the host access screen.
- The secret card shows its link (`secretRequestLink`), as on desktop.
- Tests for the feed mapping and the card.

## Connection modes and providers

- `add_host` is a Solus agent tool. Claude and Codex behave the same.
- The SSH add runs on the session's host, which holds the SSH keys and the
  forward. A web client never runs SSH.
- A web client on HTTPS cannot mint from a plain HTTP host. The card then
  offers the approval request and the typed code.
- An approval request needs the target to be reachable from the session host.
  The card says so when it is not.

## Reverse states

- A pending approval can be denied, and it expires.
- An added machine is removed with `remove_host` or Forget on the host page.
- A device token from an approval is listed and revocable with the other
  paired devices.
