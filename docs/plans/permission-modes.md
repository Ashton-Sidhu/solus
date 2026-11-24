# Permission modes

Status: done. This replaces the Solus permission handler (`ask`, `auto`, `plan`).

## Decision

Solus keeps no allow rules of its own. Each session has one permission mode.
Solus maps the mode to the provider's own permission system, and the provider
decides which tool calls need a person. Solus shows those requests as
permission cards and sends the answers back.

The first four modes are the same as T3 Code's runtime modes. T3 Code has a
separate plan toggle; Solus does not. Plan is the fifth value in the same list,
so the composer keeps one picker and one cycle shortcut.

| Mode | Label | Claude SDK `permissionMode` | Codex `approvalPolicy` / reviewer / sandbox |
|---|---|---|---|
| `supervised` | Supervised | `default` | `untrusted` / `user` / read-only |
| `accept-edits` | Accept edits | `acceptEdits` | `on-request` / `user` / workspace-write |
| `auto` | Auto | `auto` (model classifier) | `on-request` / `auto_review` / workspace-write |
| `full-access` | Full access | `bypassPermissions` | `never` / `user` / danger-full-access |
| `plan` | Plan | `plan` | `never` / `user` / read-only, `collaborationMode: plan` |

The default is `full-access`. It is the behavior Solus had before this change.
The type is `PermissionMode` in `packages/contracts/src/types.ts`. The Claude
mapping is in `claude-agent.ts`; the Codex mapping is in `codex-utils.ts`.

## Rules

- **The provider decides.** Claude applies the mode and the user's own
  `settings.json` rules before it calls `canUseTool`. Every call that reaches
  `PermissionManager` becomes a card. Solus does not auto-approve any call.
- **Two tools stay with Solus in every mode.** Claude marks `AskUserQuestion`
  and `ExitPlanMode` as needing user interaction. The CLI asks for them before
  it checks for bypass, so they reach `canUseTool` in full access too. Solus
  shows them as a question card and a plan review.
- **Deny rules still apply in full access.** The CLI checks the user's deny
  rules before the bypass check.
- **"Allow for Session" never writes settings.** Solus sends the SDK's own
  suggestions back with `destination: 'session'`. When there is no suggestion,
  it allows the tool for the session. Bash with no suggestion gets no session
  option, because a rule for the bare tool would allow every command.
- **Text in the composer is feedback on a Claude request.** While a Claude
  permission card is open, Send denies the request that the card shows and
  gives the text to the agent that asked, as the denial message. This includes
  a subagent's call. The parent gets no prompt, and other requests stay open.
  The request has `supportsFeedback`; the answer is `respondPermission` with
  `feedback`. Feedback is text only: a draft with attachments stays. The draft
  clears only when the host accepts the answer. Codex approvals carry no denial
  message, so a Codex card does not have `supportsFeedback`, and the composer
  sends a normal prompt.
- **Codex always gets the reviewer.** Solus sends `approvalsReviewer` on every
  thread and turn. A resumed thread otherwise keeps its last reviewer.
- **A mode change applies on the next turn.** Solus does not restart a running
  turn.
- **Plan approval** runs the work in the default mode from Settings, or in
  `supervised` when the user picks "Ask". When the default is `plan`, the work
  runs in `full-access`.
- **Runs with nobody present** (subagents, background prompts, automations,
  orchestrated plan implementation) run in `full-access`. Reviews and lenses
  run in `plan`. A shared prompt from another person runs in `supervised`.

## Attach a folder

A session can get a folder besides its working directory in the middle of a
turn: a session folder (`docs/plans/codebases.md` decision 8 and §6;
[Codebases](../codebases.md)). The mode decides whether a person is asked.
Solus asks with its own question card, because the folder is not a tool call
of the provider.

| Mode | A member of the session's codebase | A folder that is not a member |
|---|---|---|
| `full-access` | No card | No card |
| `auto` | No card | No card |
| `supervised` | No card | Card |
| `accept-edits` | No card | Card |
| `plan` | No card | Card |

- One card is for one folder in one session. Its choices are "Allow for this
  session", "Allow and add to the codebase" (only when the session has a
  codebase), and "Do not allow". A refused folder is not asked again in the
  turn.
- With no request by name, Solus attaches only a Git repository or a project
  that the host lists: from a prompt that a person wrote, from a blocked
  path in Auto, from "Allow for Session", and from an observed write. For
  each other path (a file in `~/Downloads`), nothing is attached, and the
  permission card of the provider answers for that one call.
- A folder that a person attaches needs no card.
- After the attach, a call in the folder follows the mode, as in the working
  directory. Claude gets a new folder at its next turn. In the turn of the
  attach, Solus allows a call there with no card only when the mode asks
  nothing for that call in the working directory: a read in each mode, and an
  edit in `accept-edits`, `auto`, and `full-access`
  (`isUnaskedInSessionFolder`). A request that matched an ask rule of the
  person always shows its card.
- Codex gets its writable roots at a turn start. In the turn of the attach,
  Solus accepts a write approval with no card only in `accept-edits` and
  `auto`, and only when each path of the request is in a granted session
  folder. `supervised` asks for each write, also in the working directory.
- "Allow for Session" on a Claude request for a path outside the folders of
  the session, and an approval for the session on a Codex request that names
  its paths, also attach the project of each path: its Git repository, or
  the listed project that holds it. A path in no project attaches nothing.
- The prompt trigger (a project that a prompt of a person names) attaches
  only in `full-access` and `auto`.
- `attach_folder` has `requiresApproval: false`: the attach rule decides, not
  the approval gate of the provider.

The rule is in `packages/server/src/execution/sessions/session-folder-attach.ts`.

## Known limits

- Claude Code refuses `bypassPermissions` when it runs as root. A host that
  runs Solus as root cannot use full access with Claude.
- Claude `auto` mode is not available on every account.
- Solus tools that require approval are not pre-allowed. In `supervised`,
  `accept-edits`, and `auto`, the provider asks for them. In `plan` they refuse
  to run.
