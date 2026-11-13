# App models

An app's code asks a model for an answer and waits for it. The UI shows the
call as it happens. The owner chooses the model in the app's config.

Status: plan. It depends on the app config system (session `efa09326`), which
holds the model choice (§4).

## 1. Vocabulary

- **model call** — one request of an app to a model: a prompt, data, the
  app's operations it may use, and an optional output schema. It is a record
  on the host, with a state, the streamed text, the tool steps, the usage, and
  the result.
- **model setting** — a config value of the kind `model`: a provider, a model,
  and an effort. The app names it; the owner sets it on the Manage page.
- **call tool** — an operation of the app that a model call may use. Only the
  app's own operations; never files, a shell, or an integration.

Do not say "agent" for a model call. An agent is a session; a model call has
no session and no transcript.

## 2. Decisions

1. **A model call is a record, not a promise.** A mutation or a workflow step
   starts it and gets its id at once. The UI watches the id. A workflow step
   can wait for the result; its receipt keeps the result, so a retry of the run
   does not pay for the call again.
2. **The model may use the app's own operations, and nothing more.** The call
   runs as a bare ephemeral provider run (`TextGenerator`'s path:
   `dispatcher.runAgent` with `bare`, `persistence: 'ephemeral'`,
   `unattended`). Each call tool runs through `Apps.callOperation` with the
   caller `{ kind: 'model', callId }`.
3. **Code never names a model id.** It names a model setting. An unset setting
   uses the host's text-generation model (`TextGenerationModelSelection`).
4. **The owner pays.** Apps are the host owner's in this release, so every call
   runs with the owner's seat, in the app's organization, under its policies.
5. **A host restart fails a running call.** An ephemeral provider run cannot be
   resumed. The record says "The host stopped during this call", and a waiting
   workflow step fails and retries under its own retry rule. Durability is the
   record and the receipt, not the run.
6. **Claude and Codex both work**, because both run through the dispatcher.
   The Replay provider (`showcase`) runs the tests.

## 3. The backend API (`ctx.models`)

An addition to protocol 3: an old build does not see it, so it needs no new
protocol (apps.md §6.3).

```ts
// app.ts — the shape of the declaration comes from the config system
config: { analyst: config.model({ label: 'Analyst', description: 'Finds CI waste.' }) }

// a mutation: start, and give the UI the id
requestAnalysis: mutation({}, async (ctx) => {
  const call = await ctx.models.start('analyst', {
    prompt: 'Find redundant steps and jobs that could run in parallel.',
    input: { pipeline: ctx.sql.exec('SELECT ...').all() },
    tools: ['durations', 'jobLog'],
    output: Findings,                 // a zod schema; the result is checked against it
  })
  return { callId: call.id }
})

// a workflow step: start and wait; the receipt keeps the result
const findings = await step.run('analyze', () => ctx.models.run('analyst', { prompt, input, output: Findings }))
```

| Member | Where | What it does |
|---|---|---|
| `start(setting, request)` | mutation, workflow step | Makes the record and queues the call. Answers `{ id }`. |
| `run(setting, request)` | workflow step | `start`, then waits for the end. Answers the result or throws the error. |
| `get(id)` | every operation | The record as the UI sees it (§5). |
| `list({ status?, limit? })` | every operation | The newest records of the app. |
| `cancel(id)` | mutation, workflow step | Stops a queued or running call. |

`request`: `prompt` (text), `input` (JSON, put in the prompt as data, at most
256 KiB), `tools` (operation names), `output` (a schema; without one the
result is the text), `timeoutSeconds` (300 by default, 900 at most), `key`
(one call for one key, as `workflows.start` has).

## 4. The model setting

The config system owns the declaration, the storage, and the Manage page
field. This plan adds one value kind to it: `model`, with a picker of the
providers and models that this host has (the picker of Settings → General's
text-generation model). A config change applies to the next call; a running
call keeps its model.

To confirm with the config system when it lands: the declaration helper's
name, where values are kept, and the event that tells the host a value changed.

## 5. What the UI sees

`@solus/app` (the frame bridge) gains:

```ts
const stop = models.watch(callId, (call) => render(call))   // the first snapshot at once, then each change
await models.cancel(callId)
```

A snapshot: `{ id, setting, provider, model, status, text, steps, result,
error, usage, startedAt, endedAt }`.

- `status`: `queued`, `running`, `done`, `failed`, `cancelled`.
- `text`: what the model wrote so far, at most 64 KiB.
- `steps`: each call tool, with its name, state, and time.
- `usage`: input and output tokens, when the provider says them.

The host sends `apps.modelCall { appId, callId, snapshot }` at most every
100 ms for each call, and at once for a change of status. The frame gets only
the calls of its own app.

## 6. Host

| File | Owns |
|---|---|
| `apps/app-model-calls.ts` | `AppModelCalls`: the records, the queue, the run, the events, and recovery at boot. |
| `data/apps/app-store.ts` | The table `app_model_calls` (baseline, as the other app tables). |
| `apps/apps.ts` | The `models.*` host requests from the runner, and the reads for the Manage page. |
| `apps/app-runner-script.ts` | `ctx.models` in the runner. |
| `contracts/apps.ts`, `rpc.ts` | The snapshot type, the RPCs, and the event topic. |

Limits: two running calls for each app, the others queued. 500 records for
each app, newest first. A result is at most 1 MiB. A call may use at most 20
call tools.

Telemetry: an `app_work` of the kind `model` in the call that started it, and
an `app_model` span with `gen_ai.request.model`, `gen_ai.provider.name`, and
`gen_ai.usage.input_tokens` / `output_tokens`.

## 7. Surfaces

| Surface | What it gets |
|---|---|
| App frame (desktop, web, mobile) | `models.watch` and `models.cancel`. |
| Manage page, desktop and web | A **Models** section: each call with its state, setting, model, time, and tokens; one call's text, steps, result, and error; Cancel. The model setting is in the config section. |
| Manage screen, mobile | The same list, one call, and Cancel; the model setting in its config section. |
| Agents | `inspect_app` gains the views `models` and `model`. |

## 8. Left out

- **A model call with files, a shell, or integrations.** That is a session;
  an app starts one with a signal action.
- **A conversation of several turns in one call.** The app keeps the history
  in its data and sends it as `input`.
- **A call that continues after a host restart** (decision 5).
- **A cost limit for each app.** The owner sees the tokens of each call; a
  limit waits until a real app needs one.

## 9. Tests

- A mutation starts a call, the UI watch sees `queued`, `running`, text, a
  tool step, and `done` with a result that the output schema checked.
- A workflow step that runs a call keeps its result: the run continues after a
  restart without a second call.
- A call that is running at boot is `failed` with the restart message.
- A call tool runs as the caller `model`, and an operation that the request
  does not name is refused.
- The setting decides the model; a changed setting applies to the next call.
- `cancel` stops the provider run and ends the record as `cancelled`.
