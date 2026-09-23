# Provider seats: every turn runs on its author's own login

**Status:** Step 2 of the cloud plan implemented on the host and in the clients (2026-09-15). The plan is the work "Solus Cloud — Step 2: Per-Member Provider Seats"; this file records the vocabulary and the decisions the code now depends on, with the section numbers the code comments cite.

**Decision this implements** (2026-09-04): every agent turn runs under the seat of the person who wrote the prompt. There is no shared organization key and no owner fallback. No seat, no turn.

## Vocabulary

- **seat** — a Claude or Codex login a turn runs on, kept as a directory the provider CLI reads (`CLAUDE_CONFIG_DIR`, `CODEX_HOME`). States: `none`, `connecting`, `connected`, `expired`. One model for everyone: the host owner's seat is the host login; a member's is made beside the data directory when they connect.
- **host login** — the host user's own provider login (`~/.claude`, `~/.codex`), which the setup wizard signs in. It is the owner's seat (`hostLogin: true` on its status; `isHostLogin` on the turn seat). The personal host's owner, automations, and the host itself run on it; the CLI stays on its defaults and the host process env passes through, so a single-person host runs exactly as before this work.
- **seat user** — whose seat a prompt runs on: a member's own; the sharer's for a guest; the host login for the owner and the host. `seatUserFor(principal)` in `packages/server/src/seats/seat-manager.ts`.
- **actor** — the ledger's view of a prompt: `{ userId, seatUserId }`. Rides `SessionRunRequest.actor` from the RPC handler to the provider launch.
- **relayed connect** — the provider's own login run on the host inside the seat directory with the browser shimmed; the URL goes out to the member's client, the code comes back on stdin.
- **token seat** — a seat connected by pasting a credential made elsewhere: a Claude `setup-token` (inference-only, so no usage meter) or a Codex `auth.json`.

## §3.1 Layout

```
<SOLUS_DATA_DIR>-seats/            0700, the server user; beside, never inside, the data directory
  bin/open, bin/xdg-open           a shim that exits 1: a relayed login prints its URL instead of opening the host's browser
  claude/<userId>/                 CLAUDE_CONFIG_DIR for that member
    projects -> <host ~/.claude>/projects
    solus-seat-token               a pasted Claude token, 0600
  codex/<userId>/                  CODEX_HOME for that member
    sessions -> <host ~/.codex>/sessions
    auth.json
```

Deviation from the plan's `shared/` tree: transcripts link into the host's own provider homes, because the session index reads those directories. Credentials are per member; transcripts are shared, so any member resumes any thread on the host.

Metadata is one table the manager owns, `provider_seat (user_id, provider, state, method, error, connected_at, last_used_at, updated_at)`, with the database handle injected. The host login has no row unless a token was pasted: its state is the CLI's own answer (`providerLoginConnected` in `seat-login.ts`), so a login made or removed in a terminal is reported truthfully, and the wizard's readiness probe reads the same function.

## §3.3 Resolution at dispatch

`ControlPlane.useSeats(seats, ledger)` is wired at boot. Every entry a person can reach carries an actor: `prompt`, `retry`, `createHeadlessSession`, `promptSession`. The seat is resolved at submit, before the prompt is echoed or queued, so the client gets the refusal and not a bubble that never answers; and again in `_launchRun`, because a queued prompt drains later and the seat may have been removed. A drained entry that is refused reaches the transcript as an error.

- `local-owner`, `remote-owner`, `system` → the host login, which always resolves. A missing login is the provider's own error at spawn, as it always was. Automations and agent follow-ups have no actor and run on the host login too.
- `org-member` → own seat, or `SEAT_REQUIRED` (`SeatRequiredError`, `code: 'SEAT_REQUIRED'`, carried on the wire by the WebSocket transport).
- `guest` → the sharer's seat; the sharer is `share.sharedByUserId`, which is the host owner sentinel when the owner shared.
- `opencode` is not a seat provider and runs with no seat.

Claude: `claudeEnv(seat)` leaves the host login's env as it stands; for a member's seat it sets `CLAUDE_CONFIG_DIR` and deletes `ANTHROPIC_API_KEY` and `CLAUDE_CODE_OAUTH_TOKEN`; a token seat's token is set either way. Codex: the host login's app-server is the pool's permanent member and also serves every catalog read; a member's seat gets its own (`CodexAppServerClient({ codexHome })`), started on first use, stopped after fifteen idle minutes, capped at eight; an idle one is evicted to make room, and with none idle the run is refused. Every run handle carries the client it started on, so steering, interrupts, and pending permission answers go to the right process.

## §3.4 The turn ledger

`packages/server/src/sessions/turn-ledger.ts`, table `session_turn (turn_id, prompt_id, session_id, user_id, seat_user_id, provider, state, created_at, started_at, settled_at)`. `turn_id` is the session emitter's trace id. Written at launch and at settlement; a write failure never blocks a turn.

## §3.5 Usage

One path for every seat: `usageLimits` answers the caller's own seat's quota (one read per connected, usage-capable seat, cached for five minutes, re-read while someone is looking) and publishes `usage.limitsChanged` only to that seat's clients. The host login's read also feeds the control plane's usage store, which the rate-limit logic reads for reset times. A token Claude seat is not probed: `/usage` under an env token degrades to a cost report.

## §3.6 Connect

RPCs (`packages/contracts/src/seats.ts`): `seatList`, `seatConnectStart` (answers once the CLI has printed where to sign in), `seatConnectSubmitCode`, `seatConnectCancel`, `seatConnectToken`, `seatDisconnect`, all host-wide and keyed on the caller's principal (a guest is refused by the access policy); `seatRemove` is host administration and refuses the host login. `host.seatChanged` is published to the seat user's clients only.

There is one relay on the host, `SeatConnector`: the setup wizard's agent sign-in was deleted (`setupAgentSignIn`, `setupSubmitAgentSignInCode`, `setupCancelAgentSignIn`) and the wizard's rows now drive the seat RPCs through `seatsStore` (`host-setup.store.svelte.ts` → `seatsStore.connectAndWait`). The host login signs in on the CLI's defaults with no seat variable set, so macOS keychain naming is untouched; a member's seat names its directory. The browser shim applies to both: the URL opens on the client's device, never on the host.

Clients: Settings → Providers → **Your seats** (`components/seats/SeatsSettings.svelte`), shown only to an organization member (their seat, with Disconnect) — the owner's seat is the host login, managed in Connections → host → AI providers; the conversation card `SeatConnectCard.svelte` on a `SEAT_REQUIRED` refusal, at the tail of the transcript beside the other interrupt cards; the onboarding rail and the host page's provider panel for install plus sign-in. All of them read `seatsStore` and mount `DevicePrompt` for the URL and code. The failed bubble keeps the retry.

## §3.7 Removal and expiry

`seatRemove` deletes a member's directory and row and refuses the host login; a daily sweep removes member seats unused for thirty days; `disconnect` deletes a member's credential and keeps the directory, and for the host login deletes only a pasted token (the CLI's own sign-in is never Solus's to remove). Marking a seat `expired` on a provider 401 during a turn is not wired yet (the manager has `markExpired`; no backend calls it).

## Not in this slice

A member's Claude login in the keychain on macOS (verify by hand whether `claude auth login` with `CLAUDE_CONFIG_DIR` writes the file or the keychain); the provider-401 → `expired` transition; a website view of seats; per-member OS identity (Step 3). The Lab's `seats` scenario proves the rule with pasted tokens; the relayed browser login is a hand proof with two real accounts.
