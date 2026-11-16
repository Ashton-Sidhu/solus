# App models

An app's code asks a model for an answer and waits for it. The UI shows the
call as it happens. The owner chooses the model in the app's config.

Status: built. It builds on the app config system (`docs/plans/apps.md` §4.4).

## 1. Vocabulary

- **model call** — one request of an app to a model: a prompt, data, the
  app's operations it may use, and an optional output schema. It is a record
  on the host, with a state, the streamed text, the tool steps, the usage, and
  the result.
- **model setting** — a config field of the type `model`. Its value is a model
  id; empty is the model Solus writes with. The app names it; the owner sets
  it on the Manage page.
- **call tool** — an operation of the app that a model call may use. Only the
  app's own operations; never files, a shell, or an integration.

Do not say "agent" for a model call. An agent is a session; a model call has
no session and no transcript.

## 2. Decisions

1. **A model call is a record, not a promise.** A mutation starts it and gets
   its id at once. The UI watches the id. A workflow step waits for the result
   (`step.model`); its receipt keeps the result, so a run that starts again
   does not pay for the call twice.
2. **The model may use the app's own operations, and nothing more.** The call
   runs as a bare, ephemeral, unattended provider run
   (`dispatcher.runAgent` with `bare`, as `TextGenerator` does). Each call tool
   runs through `Apps.callOperation` with the caller `{ kind: 'model', callId }`.
   With an output schema the run also has `submit_result`, and the call fails
   when the model ends without calling it.
3. **Code never names a model id.** It names a model setting. The value is one
   model id, because a model id names its own provider (`resolveModelId` in
   `host/settings.ts`). The code sets the effort of each call (`low`, `medium`,
   `high`): the owner knows the budget, the code knows how hard the task is.
4. **A model the host cannot run fails the call.** No other model runs in its
   place; the error says which model and what to do.
5. **The owner pays.** Apps are the host owner's in this release, so every call
   runs with the host's login, in the app's organization, under its policies.
6. **A host restart fails a running call.** An ephemeral provider run cannot be
   resumed. At boot, a queued or running record becomes `failed` with "The
   host stopped during this call." A waiting workflow step fails and retries
   under its own retry rule.
7. **Records are files, not a table.** One JSON file for each call in
   `<data dir>/apps/data/<appId>/model-calls/`, beside `config.json`. A new
   table would change the database baseline, and a host refuses a database
   whose baseline it does not know. Deleting the app deletes the folder.
8. **The UI reads; the host does not push.** `models.watch` reads the call
   every 400 ms while it runs and asks only for the text it does not have
   (`textFrom`). It needs no new event path on three clients, and it recovers
   by itself after a reconnect. The Manage page reads again on `apps.activity`
   with the kind `models`, which the host sends at most once a second while a
   call writes.
9. **Claude and Codex both work**, because both run through the dispatcher.
10. **One log.** A model call is also a row of the app's call log
    (`app_calls`, `kind` = `model`), with the id of its record: the row
    begins when the call is queued and ends with it, and recovery at boot ends
    it too (`modelCallLog` in `apps/app-observability.ts`). The row keeps the
    prompt as its input and the model's text as one log line, never the
    result. So Activity, its search and filters, the Overview counts, and
    `inspect_app`'s `calls` view hold every call of the app. The record stays
    the file of decision 7: the row only points at it.

## 3. The backend API

```ts
// app.ts
config: { analyst: { type: 'model', label: 'Analyst', description: 'Finds CI waste.' } }

// a mutation: start, and give the UI the id
requestAnalysis: mutation({}, async (ctx) => {
  const { id } = await ctx.models.start('analyst', {
    prompt: 'Find redundant steps and jobs that could run in parallel.',
    input: { pipeline: ctx.sql.exec('SELECT ...').all() },
    tools: ['durations', 'jobLog'],
    output: Findings,                 // a zod schema
    effort: 'medium',
  })
  return { callId: id }
})

// a workflow step: wait; the receipt keeps the result
const findings = await step.model('analyze', 'analyst', { prompt, input: { pipeline }, output: Findings })
```

| Member | Where | What it does |
|---|---|---|
| `ctx.models.start(setting, request)` | mutation | Makes the record and queues the call. Answers `{ id }`. |
| `ctx.models.get(id)` | every operation | The record. |
| `ctx.models.list({ status?, limit? })` | every operation | The newest records, without their text. |
| `ctx.models.cancel(id)` | mutation | Stops a queued or running call. |
| `step.model(name, setting, request)` | workflow | Starts the call, waits for its end, and answers the result or throws its error. |

`request`: `prompt` (text), `input` (JSON sent with the prompt, at most
256 KiB), `tools` (operation names, at most 20), `output` (a zod schema, which
the runner sends as JSON Schema and checks the result with again, or a JSON
Schema object), `effort` (`low` by default, in any case), `timeoutSeconds`
(300 by default, held to 10 to 900 as a step's timeout is). A request the host
does not take fails with one line that names the field.

The runner gains `ctx.models` and `step.model` in protocol 3: an old build
does not see them, so they need no new protocol (`apps.md` §6.3).

## 4. The model setting

A config field of the type `model`, beside `text`, `number`, `boolean`, and
`choice`. Its value is a string, so `AppConfigValue`, the stored file, and the
set request do not change. The Manage page offers "Solus default" and each
model the host can run (`modelSettingOptions` in `client-core/app-config.ts`,
from `textGenerationSettingsGet`). A saved model that the host no longer has
stays a choice, marked "not on this host". A change applies to the next call;
a running call keeps its model.

## 5. What the UI sees

`@solus/app` gains:

```ts
const stop = models.watch(callId, (call) => render(call))   // the call now, then each change, until it ends
await models.cancel(callId)
const { call, error, cancel } = useModelCall(callId)        // the same as React state
```

They use the call names `@models/get` (`{ id, textFrom }`) and
`@models/cancel` (`{ id }`) through the existing `appCall` bridge, on
desktop, web, and mobile.

A call: `{ id, setting, provider, model, status, text, steps, result, error,
usage, createdAt, startedAt, endedAt }`.

- `status`: `queued`, `running`, `done`, `failed`, `cancelled`.
- `text`: what the model wrote so far, at most 64 KiB.
- `steps`: each call tool, with its name, state, times, and error.
- `usage`: input and output tokens and the cost, when the provider says them.

## 6. Host

| File | Owns |
|---|---|
| `apps/app-model-calls.ts` | `AppModelCalls`: the records, the queue, the run, its tools, recovery at boot, and the reads of the RPCs, the runner, and the UI. |
| `apps/apps.ts` | Routes `models.*` from the runner and `@models/*` from the UI to `AppModelCalls`. |
| `apps/app-workflows.ts` | `step.model`: the receipt of the step. |
| `apps/app-runner-script.ts` | `ctx.models` and `step.model` in the runner. |
| `host/settings.ts` | `resolveModelId`: the installed provider of a model id. |
| `contracts/app-models.ts` | The request, the record, the view, and the RPC requests. |
| `contracts/apps.ts` | The config type `model`, the call names, the caller `model`, the step kind `model`, the span kind `model`, and the activity kind `models`. |

RPCs: `appModelCalls`, `appModelCallRead`, `appModelCallCancel`.

Limits: two running calls for each app, the others queued in order. 500
records for each app. A result is at most 1 MiB; an operation's answer to the
model is cut at 20,000 characters.

Telemetry: the provider run is an `apps` span of the host's tracer; in the
call that started it, `ctx.models.start` is a span of the kind `model`.

## 7. Surfaces

| Surface | What it gets |
|---|---|
| App frame (desktop, web, mobile) | `models.watch`, `models.cancel`, `useModelCall`. |
| Manage page, desktop and web | No section of its own: a model call is a row of the **Activity** log (decision 10), marked with a sparkle beside its setting. The row opens the call in the order it happened — prompt, operations, the model's notes, then its result or error — under its model, effort, caller, time, tokens, and Cancel. A data result shows as labelled fields (`client-core/model-result.ts`), with Show JSON and Copy. The model picker is in the Config section. |
| Manage screen, mobile | The same rows in **Activity**, titled `Model · <setting>`. A row opens the **AppModelCall** screen with the same sections, the same labelled result, and Cancel. The model picker is in Config. |
| Agents | `inspect_app` has the views `models` and `model`. |

## 8. Left out

- **A model call with files, a shell, or integrations.** That is a session;
  an app starts one with a signal action.
- **A conversation of several turns in one call.** The app keeps the history
  in its data and sends it as `input`.
- **A call that continues after a host restart** (decision 6).
- **A key that makes a second start answer the first call.** A workflow step
  already does not pay twice; a mutation that must not start twice keeps the
  id in its data.
- **A push of each change to the frame.** Decision 8.
- **A cost limit for each app.** The owner sees the tokens of each call; a
  limit waits until a real app needs one.

## 9. Tests

- `tests/unit/app-model-calls.test.ts`: a call runs with the setting's model,
  streams its text, uses its operations as the caller `model`, and keeps its
  result; a call without an output schema keeps the text; a missing result
  fails the call; an unknown setting or operation fails the start; a model the
  host cannot run fails the call; cancel stops the run; two calls run and the
  third waits; a call that was running at boot is failed; a workflow step waits
  for the result and fails with the call.
- `tests/unit/app-model-setting.test.ts`: the `model` config type, its default,
  the picker's choices, and the call names.
- Not covered here: `ctx.models` and `step.model` through a real runner. The
  runner tests (`app-runners.test.ts`, `apps-service.test.ts`) skip on a machine
  where Bun loses a child process's output.
