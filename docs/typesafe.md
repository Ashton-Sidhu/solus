# TypeSafe models

All TypeSafe SDK access belongs in `packages/server/src/typesafe/index.ts`.
Server features import this module. The lint configuration rejects direct SDK
imports elsewhere. The dependency is `@typesafe-ai/sdk` (installed with Bun to
keep the repository's lockfile).

Add a key in **Settings → Tools → Intelligence → TypeSafe API key**, or set
`TYPESAFE_API_KEY` in the host process environment. The saved key takes priority.
Remove the saved key to fall back to the environment key. Remove both to make
`ask_jev` unavailable. The tool's switch remains an independent user choice.

Keys use the host secret store: Electron safe storage on desktop, or a file with
mode 0600 under the standalone host's data directory. Only host administrators can
save or remove a key. The typed RPC returns key status, never the key value, and
does not log the submitted key. The field is shared by desktop, web, and mobile.

The shared client is created on first use and replaced when its effective key
changes. Key removal blocks new calls from existing sessions. Start a new session
after adding a key so the provider can see the tool. Calls already in progress
can finish. Changing the host process environment normally requires a restart.

`TYPESAFE_DEFAULT_MODEL` selects the default model (SDK fallback: `jev-latest`).
`TYPESAFE_BASE_URL` can select a different API root. `systemOne` accepts a model
override per request. `models.list()` discovers the models available to the account.

```ts
import { getTypeSafe, choice, noul, score } from '@solus/server/typesafe/index'

const client = getTypeSafe()
const result = await client.systemOne({
  state: { message: 'The app crashes when I open a project.' },
  questions: {
    category: choice('What does `message` concern?', {
      bug: 'A software failure.',
      feature: 'A request for new behavior.',
      other: 'Neither of these.',
    }),
    blocked: noul('Does `message` say the user cannot continue their work?'),
    severity: score('How severe is the failure described in `message`?', [
      'No failure.', 'Some behavior fails, but work can continue.', 'Work cannot continue.',
    ]),
  },
})
// Inferred as 'bug' | 'feature' | 'other'. Probabilities and usage are retained.
const category = result.answers.category.choice
const models = await client.models.list()
```

Ask independent questions about the same state together. Code owns thresholds
and actions; the interface does not convert uncertain answers into decisions.

Requests default to a 10-second timeout **per attempt** and two retries, using
the SDK's status and backoff policy. This is not a total request deadline.
Pass `{ signal, timeout, retry }` as the second argument to `systemOne`, or as
the argument to `models.list`, to control an individual call. SDK error classes
are exported from the interface; errors are not converted to successful answers.
Use `.withResponse()` on either call to get the request ID and HTTP metadata.

`createTypeSafe(config)` creates an isolated client for explicit configuration
or tests with an injected `fetch`. Production features normally use `getTypeSafe()`.
SDK logging is disabled so request state and question bodies are not logged.

The model interface runs on the server. It works in the
desktop host and standalone host and does not depend on Claude or Codex.
Web and mobile features must call a domain RPC handler on their selected host;
they must not import this module or receive saved API credentials.

## Agent tool: `ask_jev`

Claude and Codex receive `ask_jev` in normal turns, resumed turns, forks, retries,
dispatched runs, and their explicit subagent tools. Claude receives its description
without waiting for tool search. Narrow internal utility runs keep their existing
tool sets. All clients display the call through the shared tool transcript.

The tool accepts evidence in `state` (text, or JSON encoded as a string) and an
array of independent `questions`. Each question needs a unique `id`, complete
`instructions`, and a `type`:

- `choice`: two or more `options`, each with a unique `label` and `description`.
- `noul`: a yes/no question that returns the probability of yes.
- `score`: two or more `levels`, ordered from zero upward.

For example:

```json
{
  "state": "The request asks for a fix to HTTP retries. Candidates: transport.ts implements retries; theme.ts defines colors.",
  "questions": [{
    "id": "file",
    "type": "choice",
    "instructions": "Which candidate should the agent read first for this request?",
    "options": [
      { "label": "transport", "description": "transport.ts" },
      { "label": "theme", "description": "theme.ts" },
      { "label": "none", "description": "Neither candidate is relevant." }
    ]
  }]
}
```

Use it for focused semantic judgments over supplied evidence. It cannot fetch
files or inspect the agent's conversation. For ranking, use one Score per
candidate with the same levels. A Choice selects only one option. Include a
no-match option when appropriate. Ordinary code remains responsible for exact
checks, permissions, and actions.

Calls retain the host's model default unless `model` is supplied. Results include
the actual model, raw answers, token usage, `request_id`, and `elapsed_ms` including
SDK retries. Calls respect turn cancellation. Missing credentials or service
failures produce tool errors and tell the agent to continue its normal process.
The tool is available in plan mode because it makes judgments without changing
workspace state. It sends the supplied evidence to TypeSafe; do not include secrets.

Inputs are capped at 64 questions, 64 options per Choice, 32 levels per Score,
100,000 state characters, and 150,000 total input characters. These are application
bounds, not a guarantee that the request fits a particular model's token limit.

See [the benchmark plan](plans/jev-benchmark.md) for a controlled comparison with
the agent's normal process and the measurement limits of the current integration.

References: [JavaScript SDK](https://docs.typesafe.ai/sdk/javascript),
[question guidance](https://docs.typesafe.ai/primitives).
