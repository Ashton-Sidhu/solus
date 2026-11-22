# Prompt sender — fold prompts that no person typed

Status: built, 2026-11-21.

Related: `session-starter.md` (who started a session), `agent-delegation.md`,
`plans/012-user-actor-and-activity.md` §5 (the activity record).

## 1. Problem

Another agent sends prompts into a session with `start_sessions` and
`send_session`. An automation sends the first prompt of its run. Each client
showed such a prompt as a full user bubble, so a session that a coordinator
drives fills with its long messages, and the person's own prompts are hard to
find. The host knew the sender (`promptSource: 'agent'`), but no client did.
The automation label was live only: a history reload lost it, and mobile never
showed it.

## 2. Vocabulary

- **Sender** — the agent session or the automation that sent a prompt
  (`PromptSender`, the `agent` and `automation` kinds of `Attribution`). A
  prompt a person typed has no sender.
- **Folded row** — the one-line form of a prompt with a sender: an icon, the
  sender's name, the prompt's first line, and a chevron. Open, it shows the
  whole prompt and the way to the sender.

## 3. Behavior

- Desktop and web fold a prompt with a sender in `SenderPrompt.svelte`
  (inside `UserMessageBubble`). A person's prompt stays a bubble.
- Mobile does not fold it yet: a product decision of 2026-11-22. The sender
  reaches the mobile client on the event and the history row, so the folded
  row can come later with no host change.
- The label is the sender session's name as it reads now, else the name the
  host stored when it sent, else "Agent" or "Automation" (`promptSenderLabel`
  in `components/conversation/lib/user-message.ts`). An automation uses the
  stored name.
- Open, the row offers "Open session" (it reveals the sender's tab or resumes
  it) or "Open automation".
- A prompt with a sender never joins a person's burst (`user-burst.ts`).
- The open state lives in the transcript disclosure on desktop and web, so it
  survives a tab switch.

## 4. Where the host stamps it

- `PromptOptions.sender` carries it. `orchestrate-sessions.ts` sets it for a
  prompt one agent sends (`send_session`, a plan revision) and for the first
  prompt of a session one starts (`start_sessions`). `startUnattendedSession`
  sets it for an automation.
- `RunLauncher` puts it on the live `user_message` event and keeps it as a
  `prompt_sent` activity whose `by` is the sender and whose `promptHash` is the
  hash of the prompt's text. It keeps it on launch and on steer.
- `SessionHistory.loadSessionPage` and `loadSession` put it back on history
  rows (`withPromptSenders`): each record goes to the user row with the same
  text that is nearest in time, within ten minutes. Time alone cannot match: a
  history page starts at a user row, which the provider writes after the host
  sends. Text alone cannot match either: a person may type what an agent sent.
- The organization mirror reads history through `loadSession`, so mirrored
  rows carry the sender. `mergeSessionActivity` never draws a `prompt_sent`
  activity as a row.

## 5. Not covered

- A prompt from an agent on another host (`promptHeadlessSession`, a session
  another host starts) has no sender. The sender session is not on this host,
  and a client cannot open it from here.
- The queued chip of a held prompt does not show its sender.
- Media attached to a prompt with a sender still shows above the folded row.
