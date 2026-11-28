# Workflows

A call has a limit of time, and a call that fails is over. A workflow is a function that Solus runs to its end: across a deploy, a stop, and a restart of the host.

Use a workflow for a job such as an import that must resume or retry in parts. Use a regular operation for a read or a short write that can finish in one call. Keep the [trigger](triggers.md#choose-a-trigger) separate from the job so it can be started and tested through the same operation.

```ts
import { defineApp, mutation, workflow, NonRetryableError } from '@solus/app/backend'

operations: {
  startImport: mutation({ input: z.object({ fileId: z.string() }) }, (ctx, input) => ctx.workflows.start('import', input, { key: input.fileId })),
  saveRows: mutation({ input: z.object({ rows: z.array(Row) }) }, (ctx, input) => { /* one transaction */ }),
},
workflows: {
  import: workflow({ description: 'Reads one file and saves its rows.', input: z.object({ fileId: z.string() }) }, async (ctx, input) => {
    const rows = await ctx.step.do('parse', async (step) => parse(await step.files.text(input.fileId)))
    const prices = await ctx.step.do('prices', { retries: { limit: 5, delay: '10 seconds', backoff: 'exponential' }, timeout: '1 minute' }, async (step) => {
      const response = await fetch('https://api.example.com/prices', { signal: step.signal, headers: { 'Idempotency-Key': step.idempotencyKey } })
      if (response.status === 401) throw new NonRetryableError('The API token is wrong. Set it again.')
      if (!response.ok) throw new Error(`The price service answered ${response.status}.`)
      return response.json()
    })
    await ctx.step.runMutation('save', 'saveRows', { rows: withPrices(rows, prices) })
    await ctx.step.sleep('settle', '1 hour')
    await ctx.step.runMutation('check', 'checkImport', { fileId: input.fileId })
    return rows.length
  }),
},
```

- `step.do(name, options?, fn)` runs `fn` and keeps its JSON result (at most 1 MiB). `fn` gets `signal`, `attempt`, `idempotencyKey`, `secrets`, `config`, `tools`, `files`, and `signals`.
- `retries: { limit, delay, backoff }` runs a failed step again. `backoff` is `'constant'`, `'linear'`, or `'exponential'`. Throw `NonRetryableError` when more attempts cannot help. `timeout` is 5 minutes by default and 30 at most.
- `step.runQuery(name, operation, input)` and `step.runMutation(name, operation, input)` call an operation of the app. A workflow has no `sql`: it changes app data through a mutation.
- `step.sleep(name, '2 hours')` and `step.sleepUntil(name, date)` wait. A long wait holds no process.
- `step.model(name, setting, request)` waits for one model call and keeps its result ([models](models.md)).
- A duration is milliseconds, or text such as `'30 seconds'`, `'5 minutes'`, `'2 hours'`, `'1 day'`.

## How a run stays alive

Solus keeps the result of each step. When a run starts again, the function runs from its top, and each step that finished answers from what was kept. So:

- Give each step of one run its own name. A loop names its steps with the index: `` `save ${index}` ``.
- Put time, random values, and I/O inside a step, and branch on what the steps returned. Code between steps runs again each time.
- A step that was in progress when the host stopped runs again. Make a step safe to run twice: pass `step.idempotencyKey` to a service that takes one, and use `INSERT ... ON CONFLICT` in the mutation a step runs.
- A run continues on the version that is active when it starts again. Do not rename a step of a workflow that has runs in progress.
- Start a run with a `key` when the caller can call twice (a webhook, a double click): the same key and input give the same run. Use a stable ID for the requested job, such as a provider delivery ID. The run key prevents duplicate starts. The step's idempotency key protects an external write if that step runs again.

The user sees each run with its steps on the Manage page, can end one, and can start a failed run again from the failed step. In the UI, show a run's state from `ctx.workflows.get(runId)` through a query, not a spinner that guesses.

## Verify a run

Start the job through its real entry point with an authorized test input. Use `inspect_app` with `view: "runs"` to find the run and `view: "run"` with its ID to see step outcomes, attempts, wake times, and the result. Check the saved data or external result that the user asked for. If the job emits a [signal](signals.md), check its action delivery separately.

For a retry fix, use `retry_app_run` on an affected failed run after deploying the fix, when repeating that work is authorized. Check that the failed step succeeds and that previously finished work did not produce a second external change.
