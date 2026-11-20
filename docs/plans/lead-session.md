# Lead session: automatic, with a manual start

Status: implemented, 2026-10-28. Desktop, web, and mobile. Marked in the session list, 2026-10-29. Renamed to Meta mode in the UI,
2026-11-03. Automatic through `become_lead`, 2026-11-14.

A **lead session** coordinates workers and does not implement. A session
becomes a lead in two ways. Its agent calls `become_lead` when the work divides
into independent parts, so the person makes no choice first. Or the person
chooses it in the composer before the first message, and the choice is sent
with the first prompt. Each way is permanent. The sign of a lead is the
Meta mode glyph on its row in the session list. It has nothing to do with
tasks: a lead may or may not be linked to a task.

## Vocabulary

- **lead** — a session that its agent or the person made a lead. The word stays for the
  lead contract and the lead wake rule in `docs/session-orchestration.md`.
- **worker** — a session a lead started with `start_sessions`. It is listed
  under the lead's row as a delegated session (`docs/plans/task-conversation.md`
  decision 6).
- **Meta mode** — the user-facing name, on the composer's footer button, on
  the session row's glyph, and in Settings ("Meta mode"). A person reads
  "plan the work, start other sessions to do it, and report back"; "lead"
  means nothing to them. Code and docs keep `lead` for the record, the
  contract, and the wake rule. "Mode" here is the product name alone: it is
  not a permission mode, and the UI keeps the two apart by place and by
  control. Permissions are a menu of five modes in the composer card; Meta
  mode is one on-or-off button in the footer under the card. Do not call it a
  role. (Previously "Delegate", then "Coordinator mode".)

## Decisions

0. **The agent makes its session a lead.** `become_lead`
   (`execution/agents/tools/become-lead-tool.ts`) marks the calling session,
   with no input. The orchestration instructions
   (`BECOME_LEAD_INSTRUCTIONS` in `runtime-instructions.ts`) tell every session
   that has the tool when to call it: the user's work divides into two or more
   independent parts, which separate sessions can do at the same time, each
   from its own brief. A checkout is not a condition: a part can have its own
   or not, and the rule does not name one. The
   result of the call carries the lead contract with the person's lead
   settings, because the system prompt of the turn in progress cannot change;
   decision 5 gives the contract to every later run. The tool refuses a worker
   (a session another session started as its child), so one request does not
   grow into a tree of leads, and a chat. An independent session can become a
   lead. The model does not change: the lead model of decision 2 applies only
   to the composer choice. The tool is in the Sessions tool group, so a person
   who does not want automatic Meta mode turns `become_lead` off in
   Settings → Tools. When the mark is written, the host broadcasts
   `session.becameLead`, and each client shows the glyph at once: the session
   list store and the open session on desktop and web, the thread list on
   mobile. An agent's first promotion also records a `became_lead` activity.
   Desktop, web, and mobile show it as a transcript divider: “Meta mode enabled ·
   Coordinates work across sessions”. It stays visible after the turn ends and
   after reload. Repeat calls and the composer's initial choice add no divider.
1. **The person can make the choice before the first message.** The composer footer, the
   strip under the card that names the project, host, and branch
   (`InputBarFooter.svelte`), offers the Meta mode button
   (`LeadButton.svelte` in `components/input/`) to a draft and to a tab with no
   message and no provider conversation (`canChooseLead`). The button is a
   pressed-state button, filled while it is selected, not a switch. Once the
   session starts, the button is gone. There is no way to turn a lead off.
   A chat (`docs/plans/projectless-chat.md`) does not offer the button on any
   client, and `prompt-dispatch.ts` drops a choice made before the draft moved
   to a chat.
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
   when the first prompt of a new provider conversation says `isLead`, and by
   `become_lead`. The mark is never removed. `isLeadSession` reads it, and
   remembers a hit but not a miss, because the mark can arrive in the middle of
   a turn.
   Every session record read (`session-records.ts`) and every session
   description (`describeSession`) carries the mark as `isLead`, so each client
   can show it: the desktop and web sidebar row and the mobile thread row lead
   with the Meta mode glyph (lucide `Network`, the org chart; the same glyph
   as the count of sessions a row started), in accent while the session works.
5. **Every run of a lead carries the lead contract.** The run launcher appends
   `formatLeadContract` (`data/sessions/lead-contract.ts`) to the system prompt
   after the task packet when there is one, with the person's **Lead
   instructions** and **Default worker model** from the run's execution
   preferences. The contract is task-independent: `start_sessions` files a
   worker under no task, whether or not the lead is linked to one.
6. **The lead wake rule applies.** `orchestrateSessions(runtime, isLeadSession)`
   in `boot-server.ts`: a lead's reports are held until its last open message
   settles, and notices never reach its model (`docs/session-orchestration.md`).
7. **Settings live in Settings → General, "Meta mode"**
   (`LeadSessionsSection.svelte`): Meta mode model, Default worker model,
   Meta mode instructions. The keys (`leadModel`, `workerModel`, `leadInstructions`) did
   not change, so synced settings are kept.
8. **Both providers.** Claude Code and Codex get the contract through the
   system prompt; nothing is provider-specific.
9. **Mobile** offers Meta mode on a new thread as a switch in the model
   picker's Options, where T3 keeps the run options that are not the
   workspace, and sends `isLead` with the first prompt (`apps/mobile/`). The
   session row shows the same glyph (`LEAD_SYMBOL`).
10. **A quiet footer button.** Meta mode is a ghost button at the end of
   the footer under the card, filled with the accent tint while selected. The
   card's row keeps its words: the permission mode and the model with its
   reasoning effort.

## Verification

- Unit: the mark, its read, and its announcement (`lead-sessions`); the tool
  and its refusals (`become-lead-tool`); when to call it
  (`runtime-instructions`); the glyph on a live change (`session-list-store`,
  `agent-events`); the toggle's offer rule and the lead model move
  (`lead-toggle`); the contract's rules (`injected-context`); the lead wake
  rule (`session-orchestrator`, "a lead").
- Not covered by a unit test: whether a model calls `become_lead` at the
  correct time. That needs real turns on each provider.
