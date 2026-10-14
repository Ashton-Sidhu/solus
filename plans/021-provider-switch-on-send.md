# Plan 021: A provider switch happens when you send

Status: IMPLEMENTED in source (2026-10-14, uncommitted) on the server, desktop,
web, and mobile, with focused tests. Not run in a browser, on a device, or on a
simulator. The deprecated `switchSessionAgent` RPC and `switch` queue mutation
stay on the host for one release.

## Why

Today a provider pick in the composer changes the session on the host at once.
`switchSessionProvider` (`execution/sessions/provider-handoffs.ts`) runs before
the user sends anything:

- It ends the active lineage member and adds a provisional member with no
  provider thread (`beginSessionHandoff`).
- It sets the session's `agentSessionId` to null and records `agent_switched`.
- On a rate-limited session it rejects the parked prompt and clears the
  rate-limit state. A switch back does not restore them.

A switch back runs `cancelProvisionalSessionHandoff`, which deletes lineage
rows. So an accidental pick is a destructive write, and its undo is a second
destructive write that does not restore everything.

t3code keeps the pick in the composer and changes the provider only when the
user sends. We adopt that model.

## Vocabulary

- **Picked provider** — the provider and model in a session's composer. It is
  client state only. It is not durable and other clients do not see it.
- **Thread provider** — the provider that owns the session's provider thread
  now (the active lineage member, or the active session's `backendId`).
- **Pending handoff** — the picked provider differs from the thread provider.
  The client shows a "Context handoff pending" row at the end of the
  transcript. The host knows nothing about it.
- **Handoff** — what the host does when a prompt arrives with a provider that
  differs from the thread provider: it builds the handoff from the old thread
  and starts the new provider with that prompt. It records `agent_switched`.

## Rules

1. A pick writes only the composer state (`session.run.provider` and its model
   config) on the client. No RPC.
2. The pending row shows while the picked provider differs from the thread
   provider. A pick back removes it. Nothing on the host changes.
3. A prompt carries the picked provider and model, as it does today
   (`ctx.session.provider`, `preferredModel`). The host compares it with the
   thread provider:
   - Same provider: no change.
   - Different provider, session idle: hand off, then run the prompt.
   - Different provider, session busy: the prompt queues. The handoff happens
     when that prompt starts. A prompt queued earlier keeps its own provider.
4. A rate-limited session keeps its parked prompt and card after a pick. Only a
   send on another provider abandons the parked prompt, as a switch does today.
5. Plan acceptance with another provider is a send. It uses the same path.
6. The model can change inside one provider without a handoff, as today.

## Removal

- Client callers of `switchSessionAgent` and of the `{ kind: 'switch' }` queue
  mutation (desktop, web, and mobile).
- `handoffInProgress` and the pick-time `adoptHandoff` path in
  `session-config.svelte.ts`.
- `withoutProviderRoundTrips` in `conversation/lib/turns.ts`, when no host
  can record a round trip any more.
- The provisional lineage member as a state between a pick and a send. The
  handoff is begun and launched in one step.

**Compatibility.** An older mobile app can connect to a newer host. The host
keeps the `switchSessionAgent` handler and the `switch` queue mutation for one
release, marked deprecated, so those clients still work. New clients never
call them. Remove them in the next release.

**Existing state.** A session that has a provisional member from before this
change keeps working: the next send hands off as today, and a pick back is a
local change only (no cancel).

## Surfaces

- **Server:** prompt dispatch and the run scheduler decide the handoff at send
  time; plan acceptance moves to the same path; rate-limited pick keeps the
  parked prompt.
- **Desktop and web** (`packages/workspace-ui`): local pick, thread provider on
  the session state, pending row in the transcript.
- **Mobile** (`apps/mobile`): local pick, pending row, and the handoff divider
  for `agent_switched` (mobile does not draw it today).
- **Providers:** Claude and Codex both hand off. OpenCode keeps its current
  rule (the picker does not hand off OpenCode sessions).

## Tests

- Pick then pick back: no host call, no lineage change, no activity.
- Pick then send while idle: one `agent_switched`, the new provider runs the
  prompt with the handoff seed.
- Pick then send while busy: the prompt queues; the handoff happens when it
  starts; an earlier queued prompt runs on the old provider.
- Pick on a rate-limited session: the parked prompt and card stay.
- Pick then restart: nothing to recover; the composer pick is lost, which is
  acceptable for composer state.
- Plan acceptance with another provider still hands off.
