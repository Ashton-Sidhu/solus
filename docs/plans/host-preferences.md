# A host keeps its own copy of each person's preferences

Status: replaced on 2026-11-24 by [the source of a person's settings](personal-settings-source.md)
(ADR 0007). The host's copy is no longer in memory and no longer only the execution
preferences: it is every personal setting, in the host's database, and a signed-in
person's host pulls it from the account. `executionPreferencesSet` and
`HostPreferencesPublisher` are removed. The rest of this page is history. It replaced
the part of plans/018 §6 where a client sends its execution preferences with each
request.

## Problem

A client sent its whole settings snapshot (`IpcContext.settings`) with many calls,
and the host parsed the execution preferences in it with a strict schema. When a
client knew a preference that the host did not know yet (`fallbackModel`, then
`codebaseNaming`), the host refused every call that parsed the snapshot:
`Execution preferences refused: Unrecognized key`. A web or phone client that is
newer than a remote host broke the same way.

## Decision

The host reads a person's preferences from its own copy of them. A request carries
only the session and what the person chose for this one request.

## Vocabulary

- **Execution preferences** (`ExecutionPreferences`, `EXECUTION_PREFERENCE_KEYS`):
  the personal keys that a host reads while it runs work for a person. The review
  keys (`reviewAgent`, `reviewModel`, `reviewReasoning`, `reviewGuideInstructions`)
  are now in this set.
- **Host copy**: this host's copy of one person's execution preferences, by person
  key (`ownerKeyOf`). It is in memory.
- **Per-request choices**: what the person chose in the composer for one request:
  the provider (`statusBar.activeAgent`, `session.provider`), the model, the
  reasoning, fast mode, the context window, and the permission mode. They stay in
  `IpcContext.session` and `IpcContext.statusBar`.

## The one owner on the host

`packages/server/src/execution/person-preferences.ts`:

- `setPersonPreferences(sent)` replaces the copy of the person that the current
  call acts for. It reads the keys one at a time (`knownExecutionPreferences` in
  `contracts/settings.ts`). It keeps the keys that it knows and leaves out an
  unknown key or a value that does not pass its schema. It answers with the names
  of the keys that it left out. It never refuses the set.
- `actingPreferences(organizationId)` gives the copy of the person that the
  current call acts for (the acting scope, plans/019), with the policy locks of
  the work's organization laid over it (`hostPolicies().forWork(...).withLocks`,
  plans/030 §6.6). The host's own work has no person, so it gets only the locks.

These read the host copy: `prompt`, `retry`, `compactSession`, the queue's provider
switch, the agent switch, `watchSession`, the git actions and the worktree create
and move, review guides (requested, warmed, produced), review lenses,
`metricsCompileNl`, `generateSessionMetadata`, `createHeadlessSession`, and
`ensureBackgroundSessionTitle` when the session has no stored preferences.

Work that nobody asks for now reads what its run captured, as before: a session's
stored preferences (`session.execution_preferences`) and an automation's snapshot.

## What changes on the wire

- New RPC: `executionPreferencesSet(preferences) → { ignored: string[] }`. Its
  permission is `host.connect`, so a guest who prompts a shared session runs with
  their own preferences too.
- `IpcContext` is `{ session, statusBar }`. `SettingsCtx` is removed.
  `settings.activeAgent` is `statusBar.activeAgent`.
- `HeadlessSessionRequest.executionPreferences` and
  `SessionMetadataGenerationContext.executionPreferences` are removed.
- `ensureBackgroundSessionTitle(sessionId)` loses its preferences argument.
- `openInTerminal(ctx, fallbackTerminalId)` and `openWorktreeTerminal(ctx,
  fallbackTerminalId)` take the device's terminal as an argument. `openInEditor`
  uses the `fallbackTerminalId` of its request.
- Review warming is a host setting (`reviewWarmingByProject`). The host reads it
  itself.
- Automations keep their `executionPreferences` argument: it is the snapshot that
  the automation runs with, and the phone edits its permission mode there. The
  host now reads it key by key, as above, so it never refuses the call.

## Every client

One publisher, `HostPreferencesPublisher` in `client-core/host-preferences.ts`,
writes the copy to each ready host when the host connects and when the
preferences change. It writes a host only when its copy changed.

- Desktop and web: `runtime-boot.ts` follows `serverConnections.onReadinessChange`
  and `settings.personal.onChange`.
- Mobile: `solus-app.ts` follows `connections.changes` and `personal.changes`.

## Stale and offline cases

- A host restart empties the copies. Each client writes its copy again when it
  connects. Until a person's copy arrives, their work runs with the built-in
  defaults, never with another person's.
- Two clients of one person with different preferences (one not signed in): the
  last write wins on each host.
- A failed write (an older host, a dropped connection) is tried again at the next
  publish.
- A client newer than its host: the host keeps the keys that it knows and logs the
  names of the others (`person_preferences_keys_ignored`).
- An older client that sends `IpcContext.settings` and does not write a copy: the
  host ignores the snapshot, and the person's work runs with the built-in defaults.

## Providers and connection modes

Claude and Codex read the same `SessionRunInput`, so nothing is provider-specific.
Local desktop, desktop-hosted, and remote hosts use the same RPC over Electron IPC
and WebSockets.
