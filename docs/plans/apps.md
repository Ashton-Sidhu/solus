# Apps: a personal cloud on your host

Status: fifth model, built 2026-11-13 on the server, desktop, web, and mobile.
§11 says what is built and what was left out. §13 lists what the maintainers
decided. §14 says what the four earlier models were.

The reference is Executor (`UsefulSoftwareCo/executor`, read at `57961f3` on
2026-11-12 and at `31f2483` on 2026-11-13): its `apps` package, its documents,
its `app-authoring` skill, and its demo apps.

## 0. The idea

An app is a small program that lives on a host. It has a backend, its own
data, and a UI. It works when nobody looks at it.

The centre of an app is its **operations**: typed queries and mutations. Five
callers use the same operations:

- the app's **UI**, in Solus;
- an **agent**, as tools;
- a **schedule**, with no person there;
- a **webhook**, from another service;
- a **workflow** of the app itself, one step at a time.

The fourth model made an app run. The fifth model makes an app a thing you
operate:

- **A runtime.** The person gives the app a file and gets a file back. The
  backend has durable steps, retries, and sleep. The app tells the person and
  their agents that something happened.
- **Safe change.** A save and a deploy are two acts. The host builds what it
  runs. A migration applies whole or not at all. Two sessions cannot lose each
  other's change.
- **Observability.** Each call has its input, its log lines, its trace, and
  its time. Each build has its log. An agent that repairs an app reads them.
- **Management.** Each app has a Manage page. It is one click from the app,
  not a menu over it.

An app is a normal app. A deploy makes it run. It does not ask the person
before a write.

## 1. Vocabulary

- **app** — a record on a host: a name, a slug, an owner, a repository, its
  revisions, its versions, and its data. An app is not a work. An app can have
  revisions and no version.
- **app project** — the folder an agent writes in: a project from the
  `create-app` skill, which is a `visual-artifacts` project with an `app.ts`
  (§3).
- **backend** — the app's code that runs on the host: `app.ts` and what it
  imports, built into one module.
- **UI** — the app's front end: one built HTML file. An app can have no UI.
- **page** — one screen of the UI: a route in the address after `#`.
- **operation** — one query or one mutation that the backend declares.
- **query** — an operation that reads. It gets a read-only database.
- **mutation** — an operation that writes.
- **caller** — who started a call: `ui`, `agent`, `schedule`, `webhook`, or
  `workflow`.
- **call** — one execution of one operation for one caller.
- **call log** — the app's record of its calls. One row is one call of an
  operation, or one execution of a workflow's function (its caller is
  `workflow` with no step).
- **trace** — the spans of one call: each request to a network host, each
  integration tool, the SQL total, each file, each signal. A trace is an
  OpenTelemetry trace (§9.4).
- **descriptor** — what a build says the backend declares: operations with
  their schemas, schedules, webhooks, workflows, signals, secrets, roles,
  permissions, instructions, and the protocol. It is JSON and holds no code.
- **revision** — one commit of the app's source. A **save** makes one.
- **save** — to commit an app project's source as a new revision. A save
  changes nothing that runs.
- **build** — the host's run of the bundler on one revision. Its outputs are
  the descriptor, the backend module, the UI file, and the migrations. Its
  text is the **build log**.
- **version** — one immutable build of one revision. Versions have numbers
  from 1.
- **active version** — the version that runs.
- **deploy** — to build a revision on the host and make the version active.
- **app repository** — the git repository of one app. It holds every revision
  and the build of every version.
- **protocol** — the number of the contract between a build and the host: what
  `ctx` holds and what the descriptor may say (§6.3).
- **app data** — the app's own SQLite database, its app files, and its
  `files/` folder.
- **migration** — one SQL file that changes the schema of the app data.
- **app file** — one file the app holds, with a record: an id, a name, a media
  type, and a size. The person uploads one in the UI, or the backend writes
  one.
- **storage** — the app's key-value data. A UI uses it with no backend.
- **secret** — a named value the app declares and the owner gives.
- **role**, **binding** — an integration the app names by its slug, resolved
  on every call to the caller's own integration.
- **schedule** — a trigger and a mutation that the backend declares.
- **workflow** — a function of the backend that the host runs to its end, with
  durable steps (§8.3).
- **run** — one execution of one workflow, from its start to its end.
- **step** — one named unit of a run. Its result is kept, so a run that starts
  again does not do a finished step again.
- **signal** — a typed event that the app declares and emits (§8.4).
- **occurrence** — one emit of one signal, with its payload.
- **signal action** — what the owner made a signal do: a notification, a
  prompt to a session, or a run of an automation.
- **permissions** — what the backend may use outside its own data: network
  hosts and host paths.
- **agent access** — whether the app's operations are tools for agents. The
  owner turns it off and on.
- **instructions** — text the app ships for the agents that use it.
- **stopped** — the state of an app that the owner turned off.
- **link** — the tie between an app and a session that made or changed it.
- **runner** — the child process that runs one app's backend.
- **app frame** — the frame that shows a UI in Solus.
- **Apps tab** — the tab of the Workspace page that lists the apps of every
  connected host.
- **Manage page** — the page of one app where its owner operates it (§9.2).

Do not call an app a widget, a plugin, or an artifact. Do not call an
operation a host function, an action, or an endpoint. An operation is a
**tool** only where an agent sees it. Do not use "server" for the backend. Do
not call a revision a draft or a commit in the UI. Do not call a signal an
event: `apps.changed` is an event of the host. Do not call a workflow run a
job.

## 2. Decisions

1. **An app is its own record, not a work.**
2. **Operations are the centre.** The UI, an agent, a schedule, a webhook, and
   a workflow are callers of them.
3. **One authoring path: the `create-app` skill.** It starts each app from
   a checked starter app (Notes), as Executor starts from its `live-inbox`
   example, and it splits the guidance by topic so that an agent reads only
   what the app needs. The project, its `@solus/app` modules, and the bundler
   stay in the `visual-artifacts` skill: the host builds every app with that
   one bundler.
4. **The host builds.** A deploy checks out one revision into a build folder
   on the host, installs its dependencies, and runs the host's own bundler. So
   a version's build is the build of its revision, by construction. The step
   of a build that loads the backend to read what it declares runs under
   Node's permission model with no network.
5. **One git repository for each app.** `refs/heads/main` is the source, one
   commit for each save. `refs/solus/versions/<number>` is the build of that
   version.
6. **A save and a deploy are two acts.** A save makes a revision and changes
   nothing that runs. A deploy makes a version from a revision.
7. **A save names the revision it started from.** `checkout_app` and
   `save_app` write the app's slug and revision into `.solus/app.json` in the
   project. A save from a project whose revision is not the app's newest is
   refused, with the newer revision in the message. Two sessions cannot lose
   each other's change.
8. **A version is immutable.** A rollback makes an earlier version active. It
   does not rewind app data.
9. **A deploy makes the version active.** The gate is the deploy itself:
   `deploy_app` needs approval. The owner can also deploy a revision from the
   Manage page.
10. **App data is SQLite, with migrations that apply whole.** The runner
    applies the new migrations of a version in one transaction. One that fails
    leaves the database as it was. The host keeps a hash of each applied
    migration and refuses a version that edits, renames, removes, or puts a
    new file before one (§4.3).
11. **The backend runs in the runner on the host.** Not in an isolate.
12. **Only the host's owner uses an app in this release.**
13. **An operation never asks.** An agent's call follows that session's
    permission mode.
14. **An agent sees an app as an integration**, while the app's agent access
    is on.
15. **A secret is in the host's secret store, not in app data.**
16. **A schedule runs from the deploy that declares it.**
17. **An app declares its webhooks, and the webhook owner runs them.**
18. **In Solus an app shows in the app frame, on every client.**
19. **An app links to sessions, as a work does.**
20. **The Workspace page lists apps.** The Apps tab is where a person sees
    the health of every app. Each app has a Manage page.
21. **The call log keeps the input.** It keeps at most 16 KiB of each input,
    the log lines, and the trace. It never keeps a result or a secret. This
    replaces the fourth model's "no input": a person cannot repair a call they
    cannot see. The log is on the owner's own host.
22. **A build names its protocol, and the host runs every protocol it
    knows.** A host update never changes what `ctx` is for a deployed build
    (§6.3).
23. **A workflow step runs at least once.** A step that was in progress when
    the host stopped runs again. The step gets a stable `idempotencyKey`.
    Exactly-once writes are not promised.
24. **A signal does nothing by itself.** The owner's signal actions decide.
    A new signal gets one action, a notification, turned on. An action that
    starts agent work is made by the owner or by an agent's approved tool
    call, and it has a limit of 30 starts in one hour.
25. **No compatibility with the third model.**

## 3. The app project

```text
app.ts            the backend: defineApp(...)
migrations/       0001_notes.sql, 0002_tags.sql, ...
src/              the UI (React, TypeScript, Tailwind)
.solus/app.json   the app and the revision this folder came from (decision 7)
```

```ts
// app.ts
import { defineApp, query, mutation, workflow, signal } from '@solus/app/backend'
import { z } from 'zod'

const Report = z.object({ id: z.string(), title: z.string() })

export default defineApp({
  name: 'Reports',
  instructions: 'Call list before you make a report. A report takes a minute.',
  permissions: { network: ['api.example.com'] },
  secrets: { token: { label: 'API token' } },
  signals: {
    'report.ready': signal({ description: 'A report is ready.', payload: Report }),
  },
  operations: {
    list: query({ description: 'Every report.', output: z.array(Report) },
      (ctx) => ctx.sql.exec('SELECT id, title FROM reports').all()),
    request: mutation({ description: 'Make one report.', input: z.object({ title: z.string() }) },
      (ctx, input) => ctx.workflows.start('build', input)),
    save: mutation({ input: Report }, (ctx, report) => {
      ctx.sql.exec('INSERT INTO reports (id, title) VALUES (?, ?)', report.id, report.title)
      ctx.signals.emit('report.ready', report)
      return null
    }),
    importCsv: mutation({ input: z.object({ fileId: z.string() }), timeoutSeconds: 300 },
      async (ctx, input) => parse(await ctx.files.text(input.fileId))),
  },
  workflows: {
    build: workflow({ input: z.object({ title: z.string() }) }, async (ctx, input) => {
      const rows = await ctx.step.do('fetch', { retries: { limit: 3, delay: '2 seconds', backoff: 'exponential' } },
        async (step) => (await fetch('https://api.example.com/rows', { signal: step.signal })).json())
      await ctx.step.sleep('settle', '1 minute')
      await ctx.step.runMutation('save', 'save', { id: ctx.runId, title: input.title })
      return rows.length
    }),
  },
  schedules: { nightly: { cron: '0 2 * * *', run: 'request', input: { title: 'Nightly' } } },
})
```

What a handler gets in `ctx` (protocol 3):

| Field | What it is |
|---|---|
| `sql` | The app's database. `exec(sql, ...values)` gives `.all()` and `.one()`. `transaction(fn)` groups statements; `fn` is synchronous. Read-only in a query. |
| `secrets` | The values the owner gave, by name. |
| `tools` | The caller's integrations: `ctx.tools.linear.list_issues(input)`. |
| `files` | The app files: `list()`, `get(id)`, `read(id)` (bytes), `text(id)`, `path(id)`, `write(name, data, type?)`, `remove(id)`. `files.dir` is the path of the app's own `files/` folder. A query cannot write or remove. |
| `signals` | `emit(name, payload)`. In a mutation and in a workflow step. An occurrence is kept only when the call or the step succeeds. |
| `workflows` | `start(name, input, { key }?)` and `terminate(runId)` in a mutation; `get(runId)` and `list()` in every operation. |
| `caller` | `{ kind: 'ui' \| 'agent' \| 'schedule' \| 'webhook' \| 'workflow' }`. |

`console.log` and the other `console` functions write the call's log lines.

A query and a mutation take `description`, `input`, `output`, and
`timeoutSeconds` (60 by default, 900 at most). The host refuses a result that
`output` does not accept.

A build writes four outputs into `dist/app/`: `descriptor.json`,
`backend.cjs`, `ui.html`, and a copy of `migrations/`. The host makes them
(decision 4). An agent can still run `npm run bundle` to check types.

## 4. Data

### 4.1 Records

On the host's database, each app record with the canonical `organization_id`.
`packages/server/src/data/apps/` owns the tables.

| Table | Key | Holds |
|---|---|---|
| `apps` | `id` | One app: `slug`, `name`, `active_version`, `stopped`, `agent_access`, `repository`, `latest_revision`, `project`, `webhook_ids` |
| `app_versions` | (`app_id`, `number`) | One version: `source_commit` (its revision), `build_commit`, `descriptor`, `state` (`building`, `active`, `superseded`, `failed`), `error`, `build_log`, `build_ms` |
| `app_schedules` | (`app_id`, `name`) | The state of one schedule |
| `app_calls` | `id` | The call log: `operation`, `caller`, `caller_kind`, times, `outcome`, `error`, `error_stack`, `input`, `result_bytes`, `logs`, `spans`, `run_id`, `trace_id`, `span_id` (the call's OpenTelemetry span, §9.4). The newest 2,000 of each app. |
| `app_files` | `id` | One app file: `name`, `media_type`, `size`, `caller_kind` (the kind of caller that made it), `created_at` |
| `app_workflow_runs` | `id` | One run: `workflow`, `input`, `state`, `start_key`, `result`, `error`, `wake_at`, `started_by`, `interruptions`, times. The newest 500 finished runs of each app. |
| `app_workflow_steps` | (`run_id`, `name`) | One step: `kind`, `state`, `attempts`, `result`, `error`, `wake_at`, times |
| `app_signals` | `id` | One occurrence: `name`, `payload`, `emitted_at`, `call_id`, `run_id`, `deliveries`. The newest 1,000 of each app. |
| `app_signal_actions` | `id` | One signal action: `signal`, `action`, `enabled` |

An app's slug cannot be the slug of an integration the owner has.

### 4.2 The repository

One bare repository for each app, private, with no hooks, written only by the
host.

- `refs/heads/main` — the source. One commit for each save, on top of the one
  before it.
- `refs/solus/versions/<number>` — the build of that version: one commit whose
  tree is `dist/app/` and whose parent is the revision it was built from.

A source commit holds the project's own files: not `node_modules`, not `dist`,
not `.artifact`, not `.solus`.

### 4.3 App data

`<data dir>/apps/data/<app id>/`:

- `app.sqlite` — the app's database. Only the runner opens it.
- `blobs/<file id>` — the bytes of each app file. The backend reads one by its
  path. The host writes an upload; the backend writes its own.
- `files/` — a folder the backend may always read and write, with no records.
- `storage.json` — the app's storage.

`<data dir>/apps/builds/<app id>/` is the app's build folder. It keeps
`node_modules` between builds and is not app data.

**Migrations.** A migration is `migrations/<4 digits>_<name>.sql`. When a
version becomes active, the runner applies the migrations the database has not
seen, in order, all in one transaction, and records each one's name and the
SHA-256 of its text in `solus_migrations`. It refuses a version, before it
applies anything, when:

- a migration that was applied has another hash now (it was edited);
- a migration that was applied is not in the build, and the build has a
  migration with a higher number (it was removed or renamed);
- a migration that was not applied has a lower number than one that was (it
  was put before an applied one).

An earlier version that is made active again has fewer migrations than the
database has seen. That is not a refusal: the rules above compare only up to
the build's highest number.

**App files.** One file is at most 64 MiB. An app holds at most 10,000 files.
A UI sends a file in parts through its bridge (§5). Deleting the app deletes
its files.

### 4.4 Secrets and config

**Secrets** are in the host's secret store, one entry for each app. A client
reads only whether each secret is set.

**Config** (decided 2026-11-13) is the settings the owner changes without a
new version. The descriptor declares each field: `text`, `number` (with `min`,
`max`, `integer`), `boolean`, or `choice` (with `options`), each with a label
and a default; a default the field does not take fails the deploy. The values
the owner set are `config.json` in the app's data folder (§4.3), next to
`storage.json`, so no host table changes. The owner sets a value with
`appConfigSet` (`null` resets it), and the host checks it against the active
version's field. The app runs with `resolveAppConfig`: the owner's value when
the active field takes it, else the default. The runner gets the values on its
load, as it gets the secrets, so a change starts it again on the next call; the
host also says `apps.dataChanged`, so an open UI reads the config and its
queries again. The backend reads `ctx.config` (protocol 3) and `step.config`;
the UI reads `@config/get` through `useConfig`. A preview runs with the
defaults. An agent reads the values with `inspect_app` and does not set them.

## 5. Calls

Every caller goes through one function on the host:
`Apps.callOperation(appId, operation, input, caller, authority)`. It reads the
active version's descriptor, validates the input, runs the operation in the
runner, validates the output, and writes the call log.

| Caller | Who it runs as |
|---|---|
| `ui` | The viewer (the owner, in this release) |
| `agent` | The session's person |
| `schedule`, `webhook`, `workflow` | The app's owner |

**Roles.** A role is resolved on every call: the caller's MCP integration
with that slug first. When there is none, `github`, `atlassian`, and
`google` are the built-in connections (`apps/app-connections.ts`). Each has
one tool, `request` (`{ method, path, query, body }`, and `product` for
Atlassian), that sends one REST call to that provider's API with the
person's own credential. The host adds the credential, so the app never
holds it, and `path` must start with one `/`, so it cannot name another host.
An app's slug cannot be one of these three names.

**The wire names from a UI**: `@app/<operation>`, `@storage/<operation>`,
`@files/<operation>`, and `<slug>/<tool>` for an integration tool. These go to
the host through `appCall`. `@client/<operation>` is answered by the client
that holds the frame and never reaches the host.

| Name | Input | Answer |
|---|---|---|
| `@files/begin` | `{ name, type, size }` | `{ uploadId }` |
| `@files/chunk` | `{ uploadId, index, data }` (`data` is base64, at most 384 KiB of bytes) | `null` |
| `@files/commit` | `{ uploadId }` | the app file |
| `@files/list` | `{}` | the app files |
| `@files/read` | `{ id, offset }` | `{ data, size, nextOffset }` (`nextOffset` is null at the end) |
| `@files/remove` | `{ id }` | `null` |
| `@client/save` | `{ name, type, data }` (base64, at most 16 MiB of bytes) | `null`: the client gave the person the file (a download on desktop and web, the share sheet on a phone) |

The UI module (`@solus/app`) puts `files.upload(file)`, `files.list()`,
`files.read(id)`, `files.url(id)`, `files.save(id)`, `files.saveAs(name,
blob)`, and `files.remove(id)` over these names. A UI uses its own
`<input type="file">` or a drop target to get a `File`.

**Live refresh.** `apps.dataChanged { appId }` when a mutation changed the
database or an app file changed. `apps.activity { appId, kinds }` when the
call log, the runs, the occurrences, or the files changed: the Manage page
reads its open section again. The host sends at most one `apps.activity` for
each app in 500 ms.

A result is JSON, at most 1 MiB.

## 6. The runner

### 6.1 Permissions

`permissions` in `app.ts` names the network hosts the app may reach and the
host paths its backend may read and write. The runner refuses a path or a host
the app did not declare, and the frame's policy refuses a host for the UI's
`fetch`. The limits are a guard, not a jail.

### 6.2 The process

One process for each app, the host's own Node under the permission model, a
memory limit, five idle minutes. It starts for a call, a schedule, a webhook,
or a run that is due. A runner with a run in progress does not stop for idle.

The host and the runner exchange one JSON object on each line. The runner asks
the host for what the host owns: an integration tool, an app file's record, a
step's receipt, a workflow control. It sends each log line and each span as
it happens, so a call that the host stops for time keeps them.

### 6.3 Protocols

`solusApp` in the descriptor is the build's protocol. The backend module of
the project (`src/solus-app-backend.ts`) writes it, so a project keeps its
protocol until an agent replaces that file.

| Protocol | `ctx` |
|---|---|
| 2 | `sql`, `secrets`, `tools`, `caller`, and `files` as the path of the `files/` folder. No output schema, no workflow, no signal. |
| 3 | §3. |

The rules:

- The host runs every protocol in this table. `tests/unit/app-runners.test.ts`
  runs a build of each one.
- A build with a protocol the host does not know is refused at deploy, with
  the protocols the host knows in the message.
- To remove a protocol is a decision for this section, with a date.
- A new field of `ctx` that an old build cannot see needs no new protocol. A
  change to a field that an old build reads needs one.

The bridge of the app frame (`window.solusApp`) is the host's and has no
number: it only gains names.

## 7. Agents

### 7.1 Operations as tools

A run gets one tool for each operation of each running app whose agent access
is on: `<slug>__<operation>`. The description is the operation's, then the
shape of its output when it declares one. An app with instructions says so in
each description, and `inspect_app` prints them.

### 7.2 The agent's own tools

| Tool | What it does |
|---|---|
| `save_app` | `path`, `app` (a slug; omitted makes a new app or uses `.solus/app.json`), `name` (of a new app), `message`. Commits the project's source as a new revision. Refused when the app has a newer revision than the project came from, and for a folder that was not checked out from the app it names. Says which files the save removed. No approval. |
| `deploy_app` | `app`, `revision` (omitted is the newest). Builds the revision on the host, makes the version active, and links the app to the session. The receipt says the version, whether it is active, the end of the build log when it failed, what the app may use, and which secrets are not set. It needs approval. |
| `preview_app` | `path`, `width`, `appearance`, `route`. The host builds the project folder in place and gives a picture of its UI. Nothing is saved or deployed. |
| `checkout_app` | `app`, `path`, optional `version` or `revision`. Writes the source into a folder, with `.solus/app.json`. |
| `list_apps` | The apps of the host with their active version, their operations, and what needs the owner. |
| `inspect_app` | `app`, `view` (`overview`, `calls`, `call`, `runs`, `run`, `signals`, `build`), `id`. What an agent needs to repair an app: its instructions, metrics, the call log, one call with its input, log lines, and trace, the runs and their steps, the occurrences, and a build log. |
| `set_app_signal_action` | `app`, `signal`, `type` (`notify`, `send_to_session`, `run_automation`), `session_id` or `automation_id`, `template`, `action_id` (to change one), `enabled`. Makes or changes one signal action. It needs approval. |

## 8. Background work

### 8.1 Schedules

As in the fourth model: a name, an interval or a cron expression, a mutation,
and its input. A schedule that needs a long task or a retry starts a workflow
from its mutation.

### 8.2 Webhooks

As in the fourth model. A webhook's mutation answers fast: it stores the
request, or it starts a workflow.

### 8.3 Workflows

A workflow is a function `(ctx, input)` that the host runs to its end.
`ctx` has `runId` and `step`. It has no `sql`: a run changes app data through
`step.runMutation`.

| Step | What it does |
|---|---|
| `step.do(name, options?, fn)` | Runs `fn(step)` and keeps its JSON result. `options.retries` is `{ limit, delay, backoff: 'constant' \| 'linear' \| 'exponential' }`; `options.timeout` is a duration, 5 minutes by default and 30 at most. `fn` gets `signal`, `attempt`, `idempotencyKey`, `secrets`, `tools`, `files`, and `signals`. Throw `NonRetryableError` to fail at once. |
| `step.sleep(name, duration)`, `step.sleepUntil(name, time)` | Waits. A wait longer than one minute frees the runner: the host starts the run again when the time comes. |
| `step.runQuery(name, operation, input)`, `step.runMutation(name, operation, input)` | One call of an operation of the app, with the caller `workflow`. It is in the call log. |

**Durable by replay.** The host keeps a receipt for each step: its state, its
result, its attempts, and its wake time. When a run starts again (after a
sleep, a deploy, a stop, or a host restart), the function runs from its top,
and each step that has a receipt answers from it. So the code between steps
must give the same steps for the same results: put time, random values, and
I/O inside a step. Step names are unique in one run.

**States.** `running`, `sleeping`, `succeeded`, `failed`, `terminated`. A run
of a stopped app waits. A run continues on the version that is active when it
starts again; a run whose workflow the active version no longer declares
fails. A runner that stops five times in a row while a run is in progress
fails the run.

**Controls.** `ctx.workflows.start(name, input, { key })`: the same key and
input give the same run; the same key with another input is an error. The
owner terminates a run or starts a failed run again from the Manage page; the
failed step runs again and the finished steps do not.

**Limits.** An input and a step result are JSON of at most 1 MiB. A run has at
most 1,000 steps. No step is promised to run exactly once (decision 23).

### 8.4 Signals

```ts
signals: { 'report.ready': signal({ description: 'A report is ready.', payload: Report }) }
ctx.signals.emit('report.ready', { id, title })
```

A name is lower-case words with dots, at most 64 characters. A payload is JSON
of at most 64 KiB that the declared schema accepts. One call or one step emits
at most 100.

The host keeps each occurrence and gives it to each signal action of that
signal that is on:

| Action | What it does |
|---|---|
| `notify` | One notification for the owner, in the notification hub. `title` and `detail` are templates. |
| `send_to_session` | A prompt to one session. |
| `run_automation` | One run of an automation, with the rendered template as its context. A signal that must start a new session uses this: the automation holds the agent, the model, and the folder. |

A template takes `{{payload.path}}`, `{{payload}}`, `{{signal}}`, and
`{{app}}`. A payload can hold text from another service, so the host marks it
as data in a prompt, as the webhook owner does. Each occurrence keeps how each
action ended.

The first version that declares a signal gives it one `notify` action, turned
on. A signal that the active version no longer declares loses its actions.

### 8.5 Always on

A desktop host runs schedules and wakes runs only while Solus is open. A
standalone server or a cloud machine is the host for an app that must run all
day.

## 9. In Solus

### 9.1 The app surface

The app frame in all of the pane, under a thin header: the app's name, its
version, a switch between **App** and **Manage**, and a menu with Stop or
Start and Delete. The Manage switch has a dot while the app has a problem: red
for an error, amber when the only problems are secrets that are not set.
Nothing is drawn over the app for a problem. The frame stays mounted while the
Manage page shows, so the UI keeps its state.

An app with no UI opens on its Manage page.

### 9.2 The Manage page

One page for each app, on desktop, web, and mobile. Its sections:

| Section | What it shows and does |
|---|---|
| **Overview** | Running or stopped, the host, the active version, whether a newer revision waits for a deploy, the runner's state. The problems, each with a button to the section where the owner acts. The last 24 hours: calls, failed calls, the median and the 95th percentile of the time, a bar for each hour, and a row for each operation. What the app may use. Stop or Start. |
| **Activity** | The call log. Filters: operation, caller, outcome. One call opens its detail: the input, the log lines, the trace as a waterfall, the error with its stack, the run it belongs to. |
| **Workflows** | The runs, with a filter on the state. One run opens its steps: state, attempts, time, result or error, wake time. Terminate. Run again from the failed step. |
| **Versions** | The revisions and the versions in one timeline. Deploy a revision. Make a version active. The source change of each one. The build log. What each version may use. |
| **Schedules** | Pause, turn on, run now, last outcome. |
| **Webhooks** | The URL and the signing secret of each one. |
| **Signals** | Each signal: its description, its payload schema, its actions (add, change, turn off, delete), and its newest occurrences with how each action ended. |
| **Secrets** | Set, clear. |
| **Files** | The app files: name, type, size, who made it. Upload, download, delete. |
| **Operations** | Each operation with its schemas, and a form to run it with a JSON input. Agent access, on or off. The app's instructions. |
| **Sessions** | The linked sessions. |
| **Source** | The slug, the repository path, the newest revision. Delete the app. |

The sections are a rail beside the content in a wide pane and a strip above it
in a narrow one. `⌥G` switches between the app and its Manage page (`⌥M` is the pane's own key, for maximize). The route holds the view and the section: `/app/<slug>/manage/<section>`.

### 9.3 Other surfaces

| Surface | What it shows |
|---|---|
| **Apps tab** of the Workspace page | A row for each app of each connected host: name, host, state, active version, calls and failed calls of the last 24 hours, last call, and what needs attention. A row opens the app; its Manage button opens the Manage page. |
| **Conversation** | A deploy opens the app's surface beside the conversation that made it. The turn's chips name the app. |
| **Artifacts surface, session chips, turn chips** | An app the session linked. |
| **Command palette** | "Apps", "Open app…", and "Manage app…". |
| **Notification hub** | A `notify` signal action's notification. It opens the app. |
| **Mobile** | The Apps list, the app in a full-screen web view, and the Manage screen with the same sections. A file upload uses the phone's file chooser; `@client/save` opens the share sheet. |

Each way in has its way back: save and deploy, deploy and make active, stop
and start, pause and turn on, set and clear, upload and delete, add an action
and delete it, turn agent access off and on, terminate and run again.

### 9.4 OpenTelemetry

An app's telemetry is OpenTelemetry. The host has one tracer
(`execution/observability/tracer.ts`). Each span it ends goes to `metrics.db`,
which Insights reads, and, when the owner turns on the export in Settings →
Telemetry, to the owner's OTLP collector. A call of an app is a span of that
tracer, so an app needs no export of its own.

| Span (`solus.kind`) | Is | Parent |
|---|---|---|
| `app_call` | One call of an operation. Its name is the operation. | The run's `app_run` for a step's operation. For an agent's call, the span that is active at the call, if there is one. None for each other caller. |
| `app_run` | One execution of a workflow's function. Its name is the workflow. | None. |
| `app_work` | One thing a call waited for: a request, an integration tool, the SQL total, a file, a signal, a step. | Its call or its run. |

The ids are W3C ids: 32 hexadecimal characters for a trace and 16 for a span.
The call log keeps them (`trace_id`, `span_id`), and the call detail shows the
trace id with a copy control, so a person finds the same call at the collector.

The names follow the OpenTelemetry semantic conventions where a convention
exists. A collector's own HTTP, database, and error views then read an app's
trace with no mapping.

| On | Attributes |
|---|---|
| Each span | The resource (`service.name`, `service.version`), `solus.kind`, `solus.service` (`solus.apps`), `solus.organization_id`, `solus.status`, and the OpenTelemetry status (`OK` or `ERROR`). |
| `app_call`, `app_run` | `code.function.name` (the operation), `appId`, `appSlug`, `appVersion`, `operationKind`, `caller`, `callId`, `resultBytes`, and by the caller `runId`, `step`, `schedule`, `webhookId`. An agent's call has `solus.session_id`. |
| A failed call | `error.type`, and an `exception` event with `exception.type`, `exception.message`, and `exception.stacktrace`. |
| A request (`fetch`) | Span kind `CLIENT`. `http.request.method`, `server.address`, `server.port`, `url.scheme`, `http.response.status_code`. A status of 400 or more is an error with `error.type`, as the HTTP convention says for a client. Never the path or the query. |
| An integration tool | `mcp.method.name` (`tools/call`), `gen_ai.tool.name`, `integration`. |
| The SQL total | `db.system.name` (`sqlite`), `db.operation.batch.size`. Never a statement. |
| A signal | `messaging.operation.type` (`send`), `messaging.destination.name`. |
| A step | `step`, `attempt`. |

A line the app's code logged is an event of the call's span (`app_log`, with
`message` and `log.level`). `console.log` has no level in OpenTelemetry: it is
`info`. Insights shows these lines with the host's own log events.

Two metrics go to the collector when the export of metrics is on:
`app_call_duration` (a histogram, in milliseconds) and `app_calls_total` (a
counter). Each has `app`, `operation`, `operation_kind`, `caller`, and
`outcome`.

Three limits:

- A span of an `app_work` is made when the runner reports it, with the times
  the runner measured. The spans of a call that the host stopped are the ones
  the runner reported before the stop.
- The host sends no `traceparent` header on an app's request to another
  service. An app's code decides its own headers.
- A webhook's sender cannot continue its trace into the call. Each call from
  a webhook, a schedule, or a UI is a trace of its own.

The apps domain does not import the tracer. `apps/app-telemetry.ts` is the
seam: `boot-server.ts` installs `execution/observability/app-emitter.ts` in
it. With nothing installed a call runs and has no trace id.

## 10. Server

`packages/server/src/apps/` owns the domain. Data never imports it.

| File | Owns |
|---|---|
| `data/apps/` | The records and their scope rules. |
| `apps/apps.ts` | `Apps`: `save`, `deploy`, `activate`, `callOperation`, `call`, `hostRequest`, reads, `stop`, `start`, `delete`. |
| `apps/app-integrations.ts`, `app-connections.ts`, `app-summaries.ts` | An app's calls to integrations and to the built-in connections, and one app as a list shows it. |
| `apps/app-repository.ts` | Revisions, the build commit of a version, and reads of a commit's files. |
| `apps/app-project.ts` | An app project as a save reads it, and a build folder as a deploy reads it. |
| `apps/app-builder.ts` | The host's build of a revision or of a project folder (decision 4). |
| `apps/app-runners.ts`, `app-runner-script.ts` | The runner (§6). |
| `apps/app-files.ts` | App files: records, uploads in parts, reads. |
| `apps/app-workflows.ts` | Runs, receipts, the wake timer, and recovery (§8.3). |
| `apps/app-signals.ts`, `app-signal-runtime.ts` | Occurrences, signal actions, and delivery (§8.4); what an action reaches in the session runtime and the automation runner. |
| `apps/app-observability.ts` | What a call keeps, and the metrics read (§9.2). |
| `apps/app-telemetry.ts`, `execution/observability/app-emitter.ts` | The seam for a call's telemetry, and the calls as OpenTelemetry spans (§9.4). |
| `apps/app-schedules.ts`, `app-webhooks.ts`, `app-secrets.ts`, `app-storage.ts`, `app-events.ts` | As in the fourth model. |
| `transport/handlers/app-handlers.ts` | The app RPCs and the events `apps.changed`, `apps.dataChanged`, and `apps.activity`. |
| `execution/agents/tools/app-tools.ts` | The tools of §7.2 and the operations of running apps as tools. |

## 11. What was built

Built 2026-11-13 on the server, on desktop and web, and on mobile. No screen
was driven: the server is tested against a real runner, a real repository, and
a real `npm` (`tests/unit/app-runners.test.ts`, `apps-service.test.ts`,
`app-builder.test.ts`), one real project was built by the real bundler and run
in the real runner by hand, and the clients are proved by type checks and unit
tests.

What each client has of §9:

| | Desktop and web | Mobile |
|---|---|---|
| The App and Manage switch | In the header, with the dot. `⌥G`. | The header button of the app screen, with the problem count. Manage is a pushed screen. |
| The Manage page | All twelve sections, a rail or a strip by the width of the pane. | All twelve sections: a list of sections with a summary on each row, and a screen for each one. |
| An app with no UI | Opens on Manage. | Shows its operations; the header button opens Manage. |
| Signal actions | Add, change, turn off, delete, for the three types. | `notify`: add and change. `send_to_session` and `run_automation`: turn off, turn on, and delete; they are made on desktop or on the web, because the phone has no picker for a session or an automation. |
| The source change of a version or a revision | Yes. | No, as before. |
| `@client/save` | A download from the workspace's own document. | The share sheet. |
| The Apps list | State, version, calls and failed calls of 24 hours, a save that waits, each problem, a Manage button. | State, version, failed calls of 24 hours, the problem count. |

Left out, each for a reason:

- **Exactly-once steps.** A step runs at least once (decision 23).
- **A wait for a webhook or a person inside a workflow.** A workflow has
  steps and sleep. A webhook's mutation starts another run.
- **A signal that a UI or another app subscribes to.** The owner's signal
  actions are the only receivers.
- **A signal action that starts a session by itself.** It runs an automation
  (§8.4). A new session needs an agent, a model, and a folder, and an
  automation already holds them.
- **A URL for an app, other people, accounts, and the cloud copy** (§12).
- **A `traceparent` header on an app's requests, and a trace that a
  webhook's sender continues** (§9.4).
- **A build log that grows while the build runs.** The log is kept when the
  build ends; the Versions section has "Read again".
- **Paging of the call log.** A view reads the newest 100 calls and can read
  500. The log keeps 2,000.
- **A picker for the session of a `send_to_session` action.** The field takes
  a session id, as the webhook editor does.
- **A host with no `npm`.** The host builds with `npm` and Node 22 or later
  from its path. A host that has neither cannot deploy; it still runs the
  versions it has.

## 12. Later

- **The cloud copy.** The Cloudflare Artifacts target for an app's repository,
  and "install this app on another host".
- **A URL for an app.**
- **Other people.** A runtime that is a real boundary, an audience for each
  app, and Executor's two scopes for schedules and credentials (the caller's
  and the app's).
- **Accounts.** One saved credential that several apps use.
- **The source as a project.** Open an app's repository as a Solus project,
  with sessions, worktrees, and diffs.
- **A database migration for the host's own tables.** The app tables are in
  the baseline (`docs/database-schema.md`); a host database from before this
  model is not opened.

## 13. Decided

Decided 2026-11-12 by the maintainers:

- No approval for an operation, and no Allow for a version.
- Apps link to sessions, and the Workspace page lists apps.
- App schedules are the app's own, not automations.
- An app declares its webhooks; the webhook owner runs them. Executor's
  `register`, `handle`, and `unregister` callbacks are not taken.

Decided 2026-11-13 by the maintainers:

- The runtime gets files that a person uploads, durable steps with retries and
  sleep, and typed signals out.
- The host builds. A save and a deploy are separate.
- Apps get observability and a management UI that is not hidden.

## 14. The earlier models

**First, 2026-11-11.** A work type `app` whose content was one TSX component.

**Second, same day, never merged.** The component or a bundle from a separate
`apps` skill, with storage, network, and host functions.

**Third, 2026-11-11 to 2026-11-12.** An `artifact` work whose page carried an
app manifest. Its code ran only for its own page and only while the page was
open.

**Fourth, 2026-11-12 to 2026-11-13.** The app as its own record with
operations, SQLite, versions, schedules, webhooks, and secrets. It was
replaced in place by the fifth model because:

- a deploy read a build the agent made, so nothing tied a version's build to
  its source, and two sessions could overwrite each other;
- each migration committed by itself, so a failed deploy could leave a schema
  half changed;
- a call had 60 seconds, a failed schedule did not retry, and an app could
  tell nobody that something happened;
- the call log had no input, no log line, and no time, so an agent could not
  repair what it could not see;
- a UI could not take a file from the person;
- everything an owner does to an app was in a menu over the app.
