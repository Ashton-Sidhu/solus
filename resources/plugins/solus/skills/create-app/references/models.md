# Models

An app asks a model for an answer with `ctx.models`. The user chooses the model on the app's Manage page; the code names a **model setting**, never a model id. Each call is a record on the host: the UI watches it while it runs, and the Manage page lists it in the Activity log beside the operation calls.

```ts
config: {
  analyst: { type: 'model', label: 'Analyst', description: 'Finds waste in the CI pipeline.' },
},
```

Leave `default` out: an empty setting is the model Solus writes with. The user picks another one under Config.

## Start a call, and show it in the UI

A mutation starts a call and gives its id to the UI at once. Keep the id in the app's data, so a reload finds the call again.

```ts
import { z } from 'zod'

const Findings = z.object({ findings: z.array(z.object({ job: z.string(), problem: z.string(), fix: z.string() })) })

analyze: mutation({ description: 'Ask the analyst model for waste in the pipeline.' }, async (ctx) => {
  const pipeline = ctx.sql.exec('SELECT job, step, seconds FROM steps').all()
  const { id } = await ctx.models.start('analyst', {
    prompt: 'Find redundant steps and jobs that could run in parallel. Say why for each one.',
    input: { pipeline },              // JSON sent with the prompt, at most 256 KiB
    tools: ['durations'],             // operations of this app the model may call
    output: Findings,                 // a zod schema (or a JSON Schema object) for the result; without it the result is the text
    effort: 'medium',                 // 'low' (default), 'medium', 'high'
  })
  ctx.sql.exec('INSERT INTO analyses (call_id) VALUES (?)', id)
  return { callId: id }
}),
```

```tsx
import { useModelCall } from '@solus/app'

const { call, error, cancel } = useModelCall(callId)
// call.status: 'queued' | 'running' | 'done' | 'failed' | 'cancelled'
// call.text: what the model wrote so far; call.steps: each operation it called
// call.result: the result in the shape of `output`, when it is done; call.error: why it failed
```

`models.watch(id, onChange)` is the same without React. Show each state: queued, the text as it grows, each operation it calls, the result, the error, and a Cancel button while it runs.

## Wait for the result in a workflow

A workflow step waits for the call. The step keeps the result, so a run that starts again does not pay for the call twice.

```ts
const findings = await step.model('analyze', 'analyst', { prompt, input: { pipeline }, output: Findings })
await step.runMutation('save', 'saveFindings', findings)
```

## What to know

- The model may call only the operations in `tools`. It has no files, no shell, and no integrations. Give it a query that reads what it needs, rather than a large `input`.
- A query cannot start or cancel a call; it can `ctx.models.get(id)` and `ctx.models.list()`.
- Two calls of an app run at once; the others wait in order. A call takes at most `timeoutSeconds` (300 by default, 900 at most).
- A call that is running when the host stops fails with "The host stopped during this call". Start it again from the UI, or let the workflow step retry.
- A setting whose model the host cannot run fails the call with a message that says so. Show that message: the user fixes it under Config.
- A model call costs money. Start one when the user asks or when the data changed, not on each load of the UI.
