# Lead session: a per-session opt-in

Status: implemented, 2026-10-28. Desktop, web, and mobile.

A **lead session** coordinates workers and does not implement. A person chooses
it in the composer before the first message. The choice is sent with the first
prompt, fixed from then on, and shown nowhere after the session starts. It has
nothing to do with tasks: a lead may or may not be linked to a task.

## Vocabulary

- **lead** — a session the person started as a lead. The word stays for the
  lead contract and the lead wake rule in `docs/session-orchestration.md`.
- **worker** — a session a lead started with `start_session`. It is listed
  under the lead's row as a delegated session (`docs/plans/task-conversation.md`
  decision 6).
- **Delegate** — the user-facing word, on the composer switch and in Settings
  ("Delegating sessions"). A person reads "delegate work to other sessions";
  "lead" means nothing to them. Code and docs keep `lead` for the record, the
  contract, and the wake rule. Do not call it a mode or a role.

## Decisions

1. **The choice is made before the first message.** The composer toolbar offers
   the Lead toggle (`LeadToggle.svelte` in `components/input/`) to a draft and
   to a tab with no message and no provider conversation (`canChooseLead`).
   Once the session starts, the toggle is gone and nothing marks the session in
   the UI. There is no way to turn a lead off.
2. **Turning Lead on starts the session on the lead model.** When the person
   set **Lead model** in Settings → General, the run moves to it
   (`runForLead`); otherwise the run keeps its model. Turning it off changes no
   model: the person may have chosen one since.
3. **The first prompt carries it.** `PromptOptions.isLead` is sent only with
   the first message of a session (`prompt-dispatch.ts`), from
   `Session.isLead`, which a draft's `SessionSpec.isLead` sets at start. The
   host ignores it on a session that already has a provider conversation.
4. **The host marks the session.** `session_leads` (`data/sessions/schema.ts`)
   holds one row per lead, written by `markSessionLead` in the run launcher
   when the first prompt of a new provider conversation says `isLead`. The mark
   is never removed. `isLeadSession` reads it, and remembers a hit.
5. **Every run of a lead carries the lead contract.** The run launcher appends
   `formatLeadContract` (`data/sessions/lead-contract.ts`) to the system prompt
   after the task packet when there is one, with the person's **Lead
   instructions** and **Default worker model** from the run's execution
   preferences. The contract is task-independent: workers start with
   `task='none'`, and join a task with `task='attempt'` only when the lead is
   linked to one.
6. **The lead wake rule applies.** `orchestrateSessions(runtime, isLeadSession)`
   in `boot-server.ts`: a lead's reports are held until its last open message
   settles, and notices never reach its model (`docs/session-orchestration.md`).
7. **Settings live in Settings → General, "Delegating sessions"**
   (`LeadSessionsSection.svelte`): Delegating model, Default worker model,
   Delegation instructions. The keys (`leadModel`, `workerModel`, `leadInstructions`) did
   not change, so synced settings are kept.
8. **Both providers.** Claude Code and Codex get the contract through the
   system prompt; nothing is provider-specific.
9. **Mobile** offers the same toggle on a new thread and sends `isLead` with
   the first prompt (`apps/mobile/`).

## Verification

- Unit: the mark and its read (`lead-sessions`); the toggle's offer rule and
  the lead model move (`lead-toggle`); the contract's rules
  (`injected-context`); the lead wake rule (`session-orchestrator`, "a lead").
