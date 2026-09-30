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

## Known limits

- Claude Code refuses `bypassPermissions` when it runs as root. A host that
  runs Solus as root cannot use full access with Claude.
- Claude `auto` mode is not available on every account.
- Solus tools that require approval are not pre-allowed. In `supervised`,
  `accept-edits`, and `auto`, the provider asks for them. In `plan` they refuse
  to run.
