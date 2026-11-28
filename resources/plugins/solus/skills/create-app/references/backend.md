# Write app operations

## Check the contract

- For app code, read the current project's `src/solus-app-backend.ts` and `src/solus-app.ts`. They define the app's own SDK. If a feature is absent from an older project, see [upgrade the app SDK](deploy.md#an-app-from-an-older-template).
- For an integration, discover the available tool and read its input before writing the call. Check the returned shape with a small authorized read when possible. A TypeScript type argument on `ctx.tools` does not validate service data. Parse the fields the app uses at the boundary.
- For a deployed app, use `list_apps` to find its slug and operations, then read the discovered tool's input schema and the app's instructions from `inspect_app` before calling it.

## Declare operations

`app.ts` next to `package.json` makes the project an app. The starter's `app.ts` is a complete example.

```ts
import { defineApp, mutation, query } from '@solus/app/backend'
import { z } from 'zod'
import { Note } from './src/schema'

export default defineApp({
  name: 'Notes',
  description: 'A list of notes.',
  instructions: 'Search with list before you add a note, so that you do not add one twice.',
  operations: {
    list: query(
      { description: 'The 100 newest notes.', output: z.array(Note) },
      (ctx) => ctx.sql.exec<Note>('SELECT id, text, created_at FROM notes ORDER BY created_at DESC LIMIT 100').all(),
    ),
    add: mutation(
      { description: 'Save one note.', input: z.object({ text: z.string().min(1) }), output: Note },
      (ctx, input) => ctx.sql.exec<Note>(
        'INSERT INTO notes (id, text, created_at) VALUES (?, ?, ?) RETURNING id, text, created_at',
        crypto.randomUUID(), input.text, Date.now(),
      ).one(),
    ),
  },
})
```

- A **query** reads from the app or an external service. It gets a read-only database. Keep external writes out of queries too, since the UI can run a query again without a user action.
- A **mutation** changes app data or performs an external action. When it changes the database, every open UI of the app runs its queries again.
- `input` is a Zod object schema. Solus refuses input it does not accept, for every caller. Omit it for an operation that takes nothing.
- `output` is a Zod schema of what the operation answers. Solus refuses a result it does not accept, and an agent reads its shape before it calls the tool. Give one to each operation an agent uses.
- `description` is what an agent reads to choose the tool. Write one sentence for each operation.
- Use the app's `instructions` for call order, the meaning of IDs or results, and any action an agent needs to confirm with the user. An agent reads it with `inspect_app`.
- Put a row schema that the UI also uses in a file of its own under `src/` (the starter's `src/schema.ts`), with no backend code in it.
- A handler takes `(ctx, input)` and returns a JSON value, at most 1 MiB. Page large results.
- A call has 60 seconds. `timeoutSeconds` on an operation gives it up to 900. For longer work, or work that must not be lost, use a [workflow](workflows.md).
- A thrown error reaches the caller as its message. Write messages a person can act on.
- Set `requiresApproval: true` on a `query` or `mutation` when an agent must get user approval before calling it (defaults to `false` when omitted). Solus enforces this before an agent runs `<slug>__<operation>`. For UI confirmation, the UI still asks before calling it. Enforce caller access in the operation where it matters, since a hidden button cannot enforce access to a tool.
- `console.log`, `console.warn`, and `console.error` write the call's log lines. The user and an agent read them on the app's Manage page and with `inspect_app`. Log what a person needs to repair a call that failed. Never log a secret.

For an app with no UI, set `ui: false` in `defineApp`. It opens on its Manage page, where the user runs its operations.

## ctx

| Field | What it is |
|---|---|
| `ctx.sql` | The app's database. `exec(sql, ...values)` runs one statement and gives `.all()`, `.one()`, and `rowsWritten` (the count of inserted, updated, or deleted rows; `0` for `SELECT`). `transaction(fn)` groups statements; `fn` is synchronous, so do network work before or after it. |
| `ctx.secrets` | The values the user gave, by name. One that is not set is `undefined`: throw an error that says which one to set ([access](access.md)). |
| `ctx.config` | The settings the user chose on the Manage page, by field name, or each field's default ([config](config.md)). |
| `ctx.tools` | The integrations the app names: `await ctx.tools.linear.list_issues({ team: 'ENG' })` ([access](access.md)). |
| `ctx.files` | The app files: `list()`, `get(id)`, `read(id)` (bytes), `text(id)`, `path(id)`, `write(name, data, type?)`, `remove(id)`. A query cannot write or remove. `ctx.files.dir` is the path of a folder that is the app's own, with no records ([files](files.md)). |
| `ctx.signals` | `emit(name, payload)`, in a mutation ([signals](signals.md)). |
| `ctx.workflows` | `start(name, input, { key })` and `terminate(runId)` in a mutation; `get(runId)` and `list()` in every operation ([workflows](workflows.md)). |
| `ctx.models` | `start(setting, request)` and `cancel(id)` in a mutation; `get(id)` and `list()` in every operation ([models](models.md)). |
| `ctx.caller` | Who called: `{ kind: 'ui', user?, role? }`, `'agent'`, `'schedule'`, `'webhook'`, `'workflow'`, or `'model'` (an operation a model call used). Check `ctx.caller.role` (`owner`, `editor`, or `viewer`) in published apps ([deploy](deploy.md#publish)). |

## Where the backend runs

The backend runs in the app's own Node process on the host. It starts on a call and stops when idle, so keep no state in memory that the app cannot rebuild. It may use Node's built-in modules and any npm package: install it with `npm install --save-exact` and the build bundles it. It cannot start a process, start a worker, or load a native add-on. Pick a package written in JavaScript (`pg`, not a native driver).
