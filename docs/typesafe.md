# TypeSafe models

All TypeSafe SDK access belongs in `packages/server/src/typesafe/index.ts`.
Server features import this module. The lint configuration rejects direct SDK
imports elsewhere. The dependency is `@typesafe-ai/sdk` (installed with Bun to
keep the repository's lockfile).

A TypeSafe key is a person's own credential, not the host's. The vault reads it
for the person the work acts for (`docs/plans/access-model.md` §2.6,
`docs/plans/cloud-vault.md` §2.5). Signed in means your account:

- **Signed in to Solus** (the owner of a linked host, and every member): the key
  is in your Solus account. Add it on the account website's Connections page;
  Settings shows whether your account holds one and links there. Every host you
  use reads the same key. When you sign in on a host that held a key of yours,
  the host moves it into your account (a key your account holds already wins)
  and keeps no copy.
- **The owner of a host that is not linked:** add a key in **Settings → Tools →
  TypeSafe**, or set `TYPESAFE_API_KEY` in the environment that starts the host.
  The saved key takes priority. The environment key counts only for this person,
  like a `gh` login, and never once you are signed in.
- **A guest:** no key.

When the host stops being linked to you (the account removed it, or you signed
out on the desktop), the host keeps no key of yours.

On the host, the saved key uses the host secret store: Electron safe storage on desktop, or a
file with mode 0600 under the standalone host's data directory. `typeSafeKeyStatus`
returns where the caller's key is and what holds it, never the key value.
`typeSafeKeySet` changes only the caller's key and is not logged.

`getTypeSafe()` reads the acting person's key on each call. Auto model selection
uses that person's key. A call without a key answers where to add one.
Changing the host process environment normally requires a restart.

`TYPESAFE_DEFAULT_MODEL` selects the default model (SDK fallback: `jev-latest`).
`TYPESAFE_BASE_URL` can select a different API root. `systemOne` accepts a model
override per request. `models.list()` discovers the models available to the account.

```ts
import { getTypeSafe, choice, noul, score } from '@solus/server/typesafe/index'

const client = await getTypeSafe()
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

References: [JavaScript SDK](https://docs.typesafe.ai/sdk/javascript),
[question guidance](https://docs.typesafe.ai/primitives).
