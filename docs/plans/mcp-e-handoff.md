# MCP phase E handoff: MCP prompts as slash commands, with the argument form

Branch: `solus/edebf83b` (the worktree branch), from
`solus/merge-mcp-wave-branches` (`4908f45fc`). Nothing was pushed. No pull
request was opened. The plan is `mcp-first-class.md` §10.

## Commits

- `9ee2954d6` feat(mcp-prompts): list and expand MCP prompts on the host.
- `9629399dd` feat(mcp-prompts): MCP prompts in the slash menu, the argument
  form, and the mobile + menu.
- `673598215` fix(mcp-prompts): give each argument field a ref slot before it
  mounts (found by the screenshot harness).
- The commit that adds this file, the §10 corrections, and
  `docs/integrations.md` "MCP prompts".

## The host

- **Server facts.** `ServerFacts` gains `prompts: ListedPrompts | null`
  (`upstream-session.ts`, beside the tool list). `IntegrationGateway.promptsFor`
  lists `prompts/list` after the tools, only when the server declares
  `prompts`, with the person's connection, at most 200 for one server. It
  follows `ttlMs` (the smallest of the pages), and `prompts/list_changed` drops
  the list and sends `integration.changed` `facts`. A new list with other names
  sends it too. A tool relist keeps the prompts unless the session had closed
  (`promptsKept`). The SDK's own response cache is bypassed
  (`cacheMode: 'refresh'`): the gateway's cache decides.
- **stdio.** `SavedServerFacts` gains `prompts?`; a command that is not running
  answers from them and starts nothing. A send starts it, for the person, under
  `commandStartRefusal`.
- **No connection.** `promptsFor` throws `ConnectionRequiredError`; the list
  names the server in `signIn`. No anonymous request is made for a prompt.
- **`integrations/integration-prompts.ts`.** `integrationPromptList` (the RPC
  answer; `integrationsForRun` is now shared with the toolbox, so project scope
  and the stdio admin rule apply the same way) and `integrationPromptText` (the
  required-argument check, `prompts/get`, the connect card for `sessionId`).
- **`integrations/prompt-content.ts`.** One text from the messages: a user
  text as it is, assistant parts under `Assistant:`, an image or audio as an
  attachment in the conversation's attachment store (checked against its
  bytes), every other part through A3's `agentResultOf`. The text is cut at
  `MAX_MCP_PROMPT_TEXT_CHARS` (100,000) with a `[Left out: …]` line that names
  the limit.
- **Contracts** (`packages/contracts/src/integrations/prompts.ts`):
  `integrationPromptList`, `integrationPromptGet` in `rpc.ts`, `rpc-planes.ts`
  (`execution`), `permissions.ts` (`host.use`; the handler checks the owner),
  `host-api.ts`. The desktop preload forwards every method, so it needed no
  entry.

## Desktop and web

- `/` menu: the prompts are a band under "MCP" after the commands, with the
  description and the argument hint (`<required> [optional]`) in the trailing
  slot. A server in `signIn` is one row, "Sign in to <server> to use its
  prompts". A prompt whose command a Solus or provider command has is left out.
  Typed MCP commands are marked in the editor like other commands.
- The list (`components/input/lib/integration-prompts.store.svelte.ts`) is read
  on the first opening of `/` in a host and project; a keystroke reads nothing.
  It follows `integration.changed`, `integration.connectionChanged`, and
  reconnects, and keeps the old list while it reads.
- Starting (`mcp-prompt-composer.svelte.ts`, via `composer-commands`): no
  argument sends at once; one argument puts `/<command> ` in the line and takes
  the rest of it; more arguments, or an empty required one, open the argument
  form in the composer card. A typed line works the same way. The host's text
  goes through the composer's own `sendPrompt` with the attachments, so Claude
  and Codex get the same message and the transcript shows it whole. The line
  stays until the prompt is sent. Errors: a system message in a conversation, a
  toast for a draft, and inline in the form. A missing connection: the connect
  card in a conversation (`connectRequestStore.requestIntegration`), Settings →
  MCP from a draft. Focus returns to the input bar after send, close, and
  sign-in.
- The MCP composer module and the form load after the first screen (dynamic
  imports), to keep the startup graph near its size.
- Entry points checked: the input bar's `/` menu (the only composer that sends
  and runs Solus commands). The command palette lists no slash commands, so it
  has no entry. The document editor, the automation prompt, the task composer,
  and the plan and diff action bars pass no `onMcpPrompt` and list no MCP
  prompts: none of them sends a message that the host could expand.
- The web demo serves two servers' prompts and one sign-in
  (`apps/client/src/demo/fixtures/integrations.ts`).

## Mobile

The + menu of `ThreadComposer.tsx` gains **MCP Prompt…** (beside "Reference
Session…"). `McpPromptPicker.tsx` is a page sheet: search, prompts grouped by
server, a "Sign in to use" section, then a step with one field for each
argument and Send. Hook: `use-integration-prompts.ts` (reads while the sheet is
open; follows the same events; keeps the last list). The expanded text goes
through `controller.send`; the images join as host refs
(`attachHostFiles`). A sign-in row or a `connection-required` answer opens the
conversation's connect sheet (`ConversationController.askToConnect`, which the
`integration.connectNeeded` handler now also uses). The draft in the composer
stays.

## The argument form, for F1

`packages/workspace-ui/src/components/input/PromptArgumentForm.svelte` knows
fields and values, not prompts:

```ts
import type { ArgumentField, ArgumentValue } from '@solus/client-core/integration-prompts'
// ArgumentField = { name: string; description?: string; required: boolean }
// ArgumentValue = { name: string; value: string }

interface Props {
  title: string                 // what it fills, as the person reads it: "/github:review_pr", or a template URI
  description?: string
  fields: ArgumentField[]       // one input each, in order; `description` is the placeholder
  initialValues?: ArgumentValue[]
  submitLabel?: string          // default "Send"
  isSubmitting?: boolean        // fields disabled, button says "Sending…"
  error?: string                // shown in the footer; the values stay
  onSubmit: (values: ArgumentValue[]) => void   // only when no required field is empty; untrimmed, in field order
  onClose: () => void           // Escape or the close button; the caller returns the focus
}
```

Use `filledArguments(values)` (trimmed, empty optional fields dropped) and
`missingArguments(fields, values)` from the same client-core module. The form
focuses its first empty field when it mounts; key it by what it fills
(`{#key}`) to reset it. It sits inside the composer card (no border, a
`--solus-surface-hover` wash), and stacks its fields under a 30rem composer
container. On mobile the fields are inline in `McpPromptPicker.tsx`; F1 can
move them into a shared sheet if it needs them for templates.

## What each new element follows

- MCP rows and the "MCP" label: the existing `/` command rows and the band
  labels of `UnifiedAutocompleteMenu.svelte` (same `MenuItem`, mono title,
  meta, trailing slot).
- Argument form: the composer card's attachment row for its place; the
  conversation's connect card (`IntegrationConnectForm.svelte`) for the field
  (shadcn `Input`, `h-8 text-workspace-chrome`), the buttons (shadcn `Button`
  `sm`, ghost `icon-sm` close, `pointer-coarse:min-h-11`), and the error color
  (`--solus-status-error`); the slash menu footer for the key hints. It is not
  a dialog and has no border.
- Mobile sheet: `SessionReferencePicker.tsx` (page sheet, header with Cancel,
  search field, list rows); the + menu action follows "Reference Session…".

## Contradictions between the plan and the code (§10 is corrected)

1. The `/` menu is one ranked list, not categories: `CategorizedSlashCommands`
   gaining `mcp` would not show a category. The prompts are a labeled band.
2. The contract needed more than the plan gave: `integrationPromptList`
   answers `{ prompts, signIn }` (the sign-in state needs the servers),
   `IntegrationPrompt` gains `integrationName`, a prompt argument has no
   `title` in the SDK, and `integrationPromptGet` takes `sessionId?`/`draftId?`
   (the attachment folder and the connect card) and answers a union with
   `connection-required` instead of an error code.
3. "The lists load with the conversation" would read every server for every
   conversation opened. The list is read on the first `/` in a project; the
   plan's Loading row already allows the band to arrive later.
4. Rule 6 of §3 puts stores in `components/settings/`; this store belongs to
   the input bar and is in `components/input/lib/` (`integrations.store` is
   778 lines and loads after the first paint).
5. The brief asks that a "turned-off" integration remove its prompts. An
   integration has no on/off switch in the code (only its tools do). Removal,
   project scope, and the stdio admin rule remove its prompts; tested.
6. §6's 200,000-character text limit is for a tool result. A prompt is one
   message, so E sets 100,000 (`MAX_MCP_PROMPT_TEXT_CHARS`).

## Screenshots

From a temporary Vite harness outside the repository that mounts the real
`UnifiedAutocompleteMenu`, `PromptArgumentForm`, and `UserMessageBubble` from
this branch with the demo's prompts; the composer card around them is a copy of
`EditorInputCard`'s classes. 1440 × 900 at 2× (one at 440 px). Folder:
`/private/tmp/claude-501/-Users-sidhu-solus--git-solus-worktrees-solus-edebf83b/be04bf46-7906-40a3-b638-3c8557514dd4/scratchpad/screenshots/`

- `01-slash-menu-light.png`, `02-slash-menu-dark.png`: five Solus commands,
  then MCP prompts of GitHub and Linear and the Sentry sign-in row (dark: an
  MCP row selected).
- `03-not-connected-light.png`, `04-not-connected-dark.png`: `/sen`, the
  sign-in row of a server that is not connected.
- `05-form-empty-light.png`, `08-form-empty-dark.png`: the form, empty.
- `06-form-missing-light.png`, `09-form-missing-dark.png`: Send with the
  required `number` empty: "Required" and the field marked.
- `07-form-filled-light.png`, `10-form-filled-dark.png`: both fields filled.
- `11-form-error-light.png`: `prompts/get` failed; the reason in the form.
- `12-expanded-message-light.png`, `13-expanded-message-dark.png`: the
  expanded text as the person's message in the real bubble.
- `14-form-narrow-composer-light.png`: the form in a narrow composer, fields
  stacked.

No recording: the harness is static states, not the live flow.

The web demo of `apps/client` did not serve from this worktree: Vite's default
`fs.deny` refuses paths under `.git/`, and with that relaxed, the demo page
stopped answering while it loaded; the base commit's demo did the same, so it
is not this change. Every server was stopped by its own PID.

## Tests and checks

- New: `tests/unit/integrations/prompts.test.ts` (9): the command and the `_`
  rule, the first of two commands wins, arguments reach `prompts/get`, the
  assistant part is marked, an image is an attachment in the store and not a
  data URL, a missing required argument is refused before the server, the
  size limit is named, a disconnected server is a sign-in (list and send, no
  anonymous request, connect card), `prompts/list_changed`, removal and project
  scope, a stopped command answers from saved facts.
  `tests/unit/mcp-prompt-composer.test.ts` (13): the form opens for a missing
  required argument, one argument takes the line, the menu band and its order,
  a Solus command wins, the phone sheet sections, one read per opening and none
  per keystroke, a removed integration drops its prompts, the host's text and
  attachments are sent unchanged, a sign-in is not an error, a failure is
  reported and sends nothing.
- `bun test tests/unit/integrations/ tests/unit/mcp-prompt-composer.test.ts
  tests/unit/integrations-store.test.ts tests/unit/connect-request-store.test.ts
  tests/unit/native-mobile-thread-composer.test.ts
  tests/unit/native-mobile-composer-and-sheets.test.ts`: 381 pass, 0 fail.
- Type checks, before → after: server 129 → 129 (same lines), workspace-ui
  39 → 39, client-core 2 → 2, contracts 0 → 0, mobile 0 → 0. `apps/client`
  77, none in a changed file. `svelte-check` on workspace-ui: 311 errors and
  18 warnings, the same as the base.
- `lint:surfaces` clean. `lint:layout`: the three failures of the base
  (`ProjectChip`, `RunOnPicker`, `EditorVoiceControl`). `oxlint` on the changed
  files: no new finding except `ThreadComposer` complexity 59 → 60 (the sheet's
  conditional render); `gateway.ts` `list` stays at 28.
- Failures that are also at the base, the same way: `startup-import-graph`
  (the base is over its budget by 57 KB on web and 93 KB on desktop; this
  change adds 3,224 bytes to each, after moving the composer logic and the form
  behind dynamic imports), `native-mobile-integrations` (one label),
  `native-mobile-agent-auth` (one), `native-mobile-conversation` and
  `native-mobile-run-settings` (fewer failures here than at the base),
  `unified-autocomplete` and `settled-cards` (this install has no `runed`
  package for `svelte-sonner`; the base fails the same).

## Not done or not verified

- Mobile was not run: it needs a native build. Its code passes `check` and the
  sheet logic has unit tests; the sheet itself was not rendered.
- Desktop (Electron) and the real web client were not run; only the harness.
  The live flow from `/` to a sent message ran only in unit tests.
- No real provider turn and no real MCP server beyond the test server.
- §3 rule 7: a server that asks for input during `prompts/get` gets the
  existing elicitation handler, which declines because no tool call is
  active; the server's own answer reaches the person. The host does not yet
  answer with "This needs input that Solus can only ask for during a turn."
  (G owns that call path.)
- Settings → MCP opens at the page from a draft, not at the server's row:
  `showSettings` takes no row.
- Prompt argument completion (`completion/complete`) is left out (§20).
