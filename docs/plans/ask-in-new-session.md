# Fork and Ask in new session


Both actions create another session under the source session's exact task. If
the source belongs to a subtask, the new session belongs to that same subtask.
Neither action requests a new task or a sibling subtask.

The durable task link takes precedence over the saved task target. Task lookup
uses the stable Solus session identity, including a handoff identity. A source
without a durable task keeps its pending task target or explicit No task choice.
The execution host, task host, checkout, provider, and model are inherited.

Fork opens a separate conversation with a copy of the settled transcript. Ask
in new session opens that conversation in the companion pane and puts the
selected text in its composer as a quote. The provider fork starts on Send.
Environment refresh does not delay opening or focusing the prepared composer.

## Bugs found and fixed

- Fork requested a new subtask and looked up task ownership by provider ID.
  Both entry points now use the source's exact task and stable identity.
- A fork claimed its source provider ID in session lookup, including after it
  started. Only a worktree move within the same session retains that alias.
- Reload discarded the pending fork flag. Reconnect could attach the pending
  fork to the source runtime. Pending forks now keep their preview and cutoff
  flag, and neither reload nor reconnect attaches them to the source.
- The copied transcript made the first fork prompt look like a follow-up.
  Separate forks now run first-send task preparation and remote task linking.
- Both providers reported the source ID on a pending fork handle. The server
  mistook it for a resumed session and skipped the task link. Fork handles now
  have no provider ID until initialization. If initialization finishes before
  dispatch returns, the server still links the fork to its prepared task.
- Outbox replay omitted task ownership. It now resolves the task on its host
  before retrying the prompt, including an explicit No task choice.
- An environment refresh failure could leave an Ask tab without its quote or
  companion pane. The prepared composer now opens independently of that read.

## Remaining UX findings

The text-selection Ask action is currently wired only through the desktop
native selection menu. Web and mobile need a shared selection action. The
shared session and ownership changes apply to every client and both desktop
modes, but this change does not add that missing entry point.

Fork previews are captured at click time, while provider history is branched
at Send. A source that advances in between can produce different context from
the preview. The existing boolean cutoff does not identify an exact turn at
click time. A separate change should carry a stable provider cutoff for both
Claude and Codex before promising an exact snapshot.

An unsent Ask conversation has a quote and copied history, so closing its
companion pane retains it as an open conversation. This is consistent with
preserving written drafts, but the UI does not clearly label the pending fork.
An explicit draft label and discard action would make that state clearer.

## Verification

Focused regression tests cover exact task ownership, source/fork identity,
worktree identity continuity, pending fork reload and reconnect, preview
persistence, environment failure, and Ask quote construction. Desktop and web
builds run without starting an app or changing live session data. Interactive
checks of Editor, Pill, mobile, and live provider forks remain outstanding.
