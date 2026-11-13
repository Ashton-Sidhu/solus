# Apps: a personal cloud on your host

Status: built 2026-11-12, fourth model, on desktop, web, and mobile. No screen
was driven: the server is tested against a real runner and a real repository,
and the clients by type checks and unit tests. §11 says what each step built
and what was left out. §13 lists what the maintainers decided after the first
draft. §14 says what the three earlier models were.

The reference is Executor (`UsefulSoftwareCo/executor`, read at `57961f3`,
2026-11-12): its `apps` package, its documents, and its demo apps.

## 0. The idea

An app is a small program that lives on a host. It has a backend, its own
data, and a UI. It works when nobody looks at it.

The centre of an app is its **operations**: typed queries and mutations. Four
callers use the same operations:

- the app's **UI**, in Solus;
- an **agent**, as tools;
- a **schedule**, with no person there;
- a **webhook**, from another service.

The third model had the page at the centre. Its host functions served only
that page, only while a person had it open. That is an interactive artifact.
This model is a personal cloud: a person asks for an app, the agent writes it,
and then the person, their agents, the clock, and other services all use it.

An app is a normal app. A deploy makes it run. It does not ask the person
before a write, and no version waits for a second decision.

What stays from the third model: the `visual-artifacts` skill builds the app,
the app frame shows it on desktop, web, and mobile, and the runner runs its
code.

## 1. Vocabulary

- **app** — a record on a host: a name, a slug, an owner, a repository, its
  versions, and its data. An app is not a work.
- **app project** — the folder an agent builds in: a `visual-artifacts`
  project with an `app.ts` (§3). It is the build input.
- **backend** — the app's code that runs on the host: `app.ts` and what it
  imports, built into one module.
- **UI** — the app's front end: one built HTML file. An app can have no UI.
- **page** — one screen of the UI: a route in the address after `#`.
- **operation** — one query or one mutation that the backend declares.
- **query** — an operation that reads. It gets a read-only database.
- **mutation** — an operation that writes.
- **caller** — who started a call: `ui`, `agent`, `schedule`, or `webhook`.
- **call** — one execution of one operation for one caller.
- **call log** — the app's record of its calls.
- **descriptor** — what the build says the backend declares: its operations
  with their input schemas, its schedules, its secrets, its roles, and its
  permissions. It is JSON and holds no code.
- **build** — the outputs of one `npm run bundle`: the descriptor, the backend
  module, the UI file, and the migrations.
- **app repository** — the git repository of one app. It holds the source and
  the build of every version.
- **version** — one immutable source commit with its build. Versions have
  numbers from 1.
- **active version** — the version that runs.
- **deploy** — to make a version from an app project.
- **app data** — the app's own SQLite database and its `files/` folder.
- **migration** — one SQL file that changes the schema of the app data.
- **storage** — the app's key-value data. A UI uses it with no backend.
- **secret** — a named value the app declares and the owner gives, for example
  a database URL. The host vault keeps it.
- **role**, **binding** — as before: an integration the app names by its slug,
  resolved on every call to the caller's own integration.
- **schedule** — a trigger and a mutation that the backend declares.
- **permissions** — what the backend may use outside its own data: network
  hosts and host paths (§6). The app declares them; the runner enforces them.
- **stopped** — the state of an app that the owner turned off: no operation
  runs and no schedule fires.
- **link** — the tie between an app and a session that made or changed it, as
  for a work or an automation (`docs/plans/session-artifacts.md`).
- **runner** — the child process that runs one app's backend.
- **app frame** — the frame that shows a UI in Solus (§9).
- **Apps tab** — the tab of the Workspace page that lists the apps of every
  connected host.

Do not call an app a widget, a plugin, or an artifact. Do not call an
operation a host function, an action, or an endpoint. An operation is a
**tool** only where an agent sees it. Do not use "server" for the backend:
in Solus the server is the host's own process.

## 2. Decisions

1. **An app is its own record, not a work.** It has source, versions, data,
   schedules, and callers; a work has one body. Apps reuse what works have by
   calling the same owners (the frame, the skill, the git transport), not by
   being a work.
2. **Operations are the centre.** The UI is one caller of them. Everything an
   app does for an agent, a schedule, or a webhook is an operation the UI can
   also call.
3. **One authoring path: the `visual-artifacts` skill.** The same project,
   build, design guidelines, and preview. An `app.ts` makes the project an app.
4. **The build writes the descriptor.** The host never runs app code to learn
   what an app declares. The host enforces the descriptor: an operation the
   descriptor calls a query gets a read-only database, whatever its code does.
5. **One git repository for each app.** It uses the storage of works: a bare
   repository under the host's data folder, and Cloudflare Artifacts for a
   host in the cloud (`docs/plans/cloud-work-artifacts-integration.md`). The
   host writes the commits. An agent does not push.
6. **A version is immutable.** A deploy makes a new one. A rollback makes an
   earlier version active. A rollback does not rewind app data or what an
   operation did outside the host.
7. **A deploy makes the version active.** There is no second decision, no
   version that waits, and no decision bound to the backend's hash. The gate
   is the deploy itself: `deploy_app` is a tool that needs approval, so the
   session's permission mode decides whether a person sees it first. An app
   has no more rights than the session that deployed it had: both are code on
   the host. The owner can stop an app and start it again.
8. **App data is SQLite, with migrations.** The runner applies new migrations
   when a version becomes active. A migration that fails stops the activation.
9. **The backend runs in the runner on the host.** Not in an isolate. An app
   on your host can read your files and reach your private network when it
   declares them. That is the point of an app on your own machine (§6, §12).
10. **Only the host's owner uses an app in this release.** Their UI, their
    agent sessions, the app's schedules, and the webhooks that call it.
11. **An operation never asks.** A call from the UI, a schedule, or a
    webhook runs. An app has no approval setting and no `writes` permission,
    for its own operations and for the integration tools it calls. An agent's
    call follows that session's permission mode, as any integration tool does.
12. **An agent sees an app as an integration.** The gateway lists the app's
    operations as tools. Tool lists, approval, and turned-off tools work as
    they do for any integration.
13. **A secret is in the vault, not in app data.** The backend gets it at run
    time. No client, no UI, and no agent reads it back.
14. **A schedule runs from the deploy that declares it.** The owner can pause
    it and turn it on again.
15. **An app declares its webhooks, and the webhook owner runs them.** The
    declaration names a verification and a mutation. A deploy makes the webhook
    record. The app's menu shows the URL, and the person copies it into the
    other service. An app has no `register` step: that needs accounts (§12).
16. **In Solus an app shows in the app frame, on every client.** Not in the
    browser pane (§9 says why). An app is a window with its own pages.
17. **No compatibility with the third model.** Solus has no users. Apps that
    are artifacts stop being apps; their pages stay as plain artifacts.
18. **An app links to sessions, as a work does.** The session that deploys an
    app is linked to it. The `link` tool, the Artifacts surface, the chips on
    a session card, and the chips under a turn take the kind `app`.
19. **The Workspace page lists apps.** A fourth tab, **Apps**, beside the
    works and the shared sessions. There is no separate Apps page.

## 3. The app project

A `visual-artifacts` project with these files:

```text
app.ts            the backend: defineApp(...)
migrations/       0001_notes.sql, 0002_tags.sql, ...
src/              the UI (React, TypeScript, Tailwind), as for any artifact
skills/           optional: instructions for agents that use the app
```

```ts
// app.ts
import { defineApp, query, mutation } from '@solus/app/backend'
import { z } from 'zod'

export default defineApp({
  name: 'Notes',
  permissions: { network: ['*'], files: { read: [], write: [] } },
  secrets: { database: { label: 'Database URL', description: 'A Postgres URL.' } },
  operations: {
    list: query(
      { description: 'The 100 newest notes.', input: z.object({}) },
      (ctx) => ctx.sql.exec('SELECT id, text FROM notes ORDER BY created_at DESC LIMIT 100').all(),
    ),
    add: mutation(
      { description: 'Save one note.', input: z.object({ text: z.string() }) },
      (ctx, input) => ctx.sql.exec('INSERT INTO notes (id, text, created_at) VALUES (?, ?, ?) RETURNING id, text',
        crypto.randomUUID(), input.text, Date.now()).one(),
    ),
  },
  schedules: {
    digest: { cron: '0 9 * * 1-5', timezone: 'America/Toronto', run: 'sendDigest', input: {} },
  },
})
```

```tsx
// src/App.tsx
import { useQuery, mutate } from '@solus/app'
const notes = useQuery('list', {})          // runs again when the app's data changes
await mutate('add', { text })
```

What a handler gets in `ctx`:

| Field | What it is |
|---|---|
| `sql` | The app's database. `exec(sql, ...values)` gives `.all()` and `.one()`. Each statement commits by itself; `transaction(fn)` groups statements, and `fn` is synchronous. Read-only in a query. |
| `secrets` | The values the owner gave, by name. |
| `tools` | The caller's integrations: `ctx.tools.linear.list_issues(input)`. |
| `files` | The path of the app's `files/` folder. |
| `caller` | `{ kind: 'ui' \| 'agent' \| 'schedule' \| 'webhook' }`. |

`npm run bundle` builds four outputs into `dist/app/`: `descriptor.json`,
`backend.cjs` (absent when the app declares no operation), `ui.html` (absent
when the project has no UI), and a copy of `migrations/`. The build makes the
descriptor from `app.ts` in the agent's own environment, with `z.toJSONSchema`
for each input.

## 4. Data

### 4.1 Records

On the host's database, each with the canonical `organization_id`
(`docs/plans/organization-scope.md` §3):

```ts
interface App {
  id: string
  slug: string                  // unique on the host; the agent tool namespace
  name: string
  organizationId: string
  createdBy: Attribution
  activeVersion: number | null  // null: the first deploy failed
  stopped: boolean
  repository: { provider: 'local-git' | 'cloudflare-artifacts'; name: string; scope: string }
}
interface AppVersion {
  appId: string
  number: number
  sourceCommit: string
  buildCommit: string
  descriptor: AppDescriptor
  state: 'active' | 'superseded' | 'failed'
  message: string
  createdBy: Attribution
  createdAt: string
}
interface AppSchedule {
  appId: string
  name: string                  // the key in the descriptor
  enabled: boolean              // true when first seen
  nextRunAt?: string
}
interface AppCall {
  id: string; appId: string; version: number
  operation: string
  caller: { kind: 'ui' | 'agent' | 'schedule' | 'webhook'; sessionId?: string; scheduleName?: string; webhookId?: string }
  startedAt: string; finishedAt?: string
  outcome: 'ok' | 'failed'
  error?: string
}
```

The call log keeps no input and no result. It keeps the last 2,000 calls of
each app.

An app's slug cannot be the slug of an integration the owner has: both are
`tools.<slug>` to an agent and to a UI. A deploy that makes a new app adds a
short suffix when the slug is taken.

### 4.2 The repository

One bare repository for each app: `<data dir>/apps/repositories/app-<hash>.git`
on a host (`apps/app-repository.ts`), with the conventions of a work's local
repository: private, bare, no hooks, written only by the host. The app's row
keeps the repository's name. A Cloudflare Artifacts repository for a host in
the cloud is later (§12).

- `refs/heads/main` — the source. One commit for each deploy: the project's own
  files (not `node_modules`, not `dist`), with the deploy's message.
- `refs/solus/versions/<number>` — the build of that version: one commit whose
  tree is `dist/app/` and whose parent is the source commit.

So one repository holds the whole app at every version: a rollback, a copy to
another host, and a cloud copy need nothing else. `git clone` of the
repository gives a person the source with a normal history. Direct pushes are
not supported.

### 4.3 App data

`<data dir>/apps/data/<app id>/`:

- `app.sqlite` — the app's database. Only the runner opens it.
- `files/` — a folder the backend may always read and write.
- `storage.json` — the app's storage, as now (`app-storage.ts`).

A migration is `migrations/<4 digits>_<name>.sql`. The runner applies each new
one in order, each in a transaction, and records it in the table
`solus_migrations`. Migrations only go forward. Deleting the app removes the
folder, the repository, its schedules, its secrets, and its integration.

### 4.4 Secrets

An app's secrets are in the host's secret store, one entry for each app, as a
webhook's token and signing secret are (`apps/app-secrets.ts`,
`data/webhooks/webhook-secrets.ts`). They are not in a table and not in the
app's data. The owner gives a value in the app's menu. A client reads only
whether each secret is set. The runner gets the values when it starts, and it
starts again when one changes. An operation that reads a secret that is not
set gets `undefined` and says so in its own error.

The cloud vault is not used: it holds a person's credentials, which follow
the person. An app's secret belongs to one app on one host.

## 5. Calls

Every caller goes through one function on the host: `Apps.call(appId,
operation, input, caller)`. It reads the active version's descriptor, checks
the caller, validates the input against the operation's schema, runs the
operation in the runner, and writes the call log.

| Caller | Who it runs as |
|---|---|
| `ui` | The viewer (the owner, in this release) |
| `agent` | The session's person |
| `schedule` | The app's owner |
| `webhook` | The app's owner |

A query and a mutation differ in two things only: a query gets a read-only
database, and a mutation that changed the database starts a live refresh. To
the gateway a query is `readOnlyHint: true` and a mutation is not, so an
agent's session treats them as it treats the tools of any integration.

**The wire names from a UI** stay: `@storage/<operation>` for storage, and
`<slug>/<tool>` for an integration tool. `@server/<function>` becomes
`@app/<operation>`.

**Integrations.** A UI (`tools.<slug>.<tool>`) and a backend (`ctx.tools`)
call the tools of the roles the descriptor names, with the caller's own
connection. The owner can turn a tool off for an integration in Settings →
Tools, and that holds for an app too.

**Live refresh.** When a mutation ends and the database changed, the host
sends `appDataChanged { appId }` on a new RPC topic. Each client posts
`solus-app-event` to the open frames of that app, and `useQuery` runs its
query again. The refresh is coarse on purpose: one event for the app, not one
for each table.

A call has 60 seconds. A result is JSON, at most 1 MiB.

## 6. Permissions and the runner

`permissions` in `app.ts` names the network hosts the app may reach and the
host paths its backend may read and write. `*` is every host or every path.
The app's own data needs no permission. The Versions section of the app's
menu shows the permissions of each version in one sentence, and the receipt
of a deploy says the same sentence to the agent.

Nobody decides the permissions a second time. They are there so that an app
does what it says: the runner refuses a path or a host the app did not
declare, and the frame's policy refuses a host for the UI's `fetch`.

The runner is the third model's (`app-functions.ts`, `app-runner-script.ts`):
one process for each app, the host's own Node under the permission model, the
app's paths, the socket check, no child processes, a memory limit, five idle
minutes. It changes in three ways:

- It loads the backend module and takes its operations from the default
  export, not from the module's exports.
- It opens `app.sqlite` with `node:sqlite`: one read-only connection for
  queries and one for mutations. It applies new migrations before it says it
  is ready. A migration that fails makes the version `failed`, and the version
  before it stays active.
- A schedule or a webhook starts it, so it does not need an open UI.

**Stop** in the app's header stops the runner and every schedule. The UI
still opens, and an operation fails with a message that says the app is
stopped. **Start** reverses it.

The runner's limits are a guard, not a jail: SQL that opens another file
(`ATTACH`) is not checked, and on Node 24 the socket check in the runner is
the only network check. That is acceptable because an app is the owner's own
code on the owner's own host (decisions 7 and 10).

Removed from the third model: host access, its three states, the Allow and
Revoke bar, the decision on the work's meta, and the hash of the backend.

## 7. Agents

### 7.1 Operations as tools

A run gets one tool for each operation of each running app, beside the tools
of the person's integrations: `appOperationAgentTools` in
`execution/agents/tools/app-tools.ts`, called where a run lists its
integration tools (`run-launcher.ts`). The name is `<slug>__<operation>`, as
an integration's tools are named, so an agent sees
`mcp__solus__<slug>__<operation>`. The input schema is the operation's. The
call goes to `Apps.callOperation` with the caller `agent`. A name that a tool
of the run already has is left out.

An app is not an integration record. It needs no MCP session, and its tools
change when its active version changes, with no list to keep in step.
Settings → Tools does not list an app's operations; the app's own surface
does.

### 7.2 The agent's own tools

| Tool | What it does |
|---|---|
| `deploy_app` | `path` (the app project), `app` (a slug; omitted makes a new app), `message`. Reads `dist/app/` and the source files, writes the two commits, makes the version active, and links the app to the session. The receipt says the version's number, whether it is active or failed, what the app may use, and which secrets are not set. It needs approval. |
| `preview_app` | `path`, `width`, `appearance`, `route`. Deploys nothing and gives a picture of the project's UI in a window 800px tall. It needs no approval. |
| `checkout_app` | `app`, `path`, optional `version`. Writes the source of a version into a folder, so a later session can change the app. |
| `list_apps` | The apps of the host with their active version, their operations, and what needs the owner. |

`create_app` is removed. The preview is a tool of its own because a tool's
approval is one flag: a look at a UI must not ask as a deploy does. The `link`
tool takes `kind: 'app'` with the app's slug.

A preview answers storage from memory. It runs the project's operations in a
runner against a new database with the project's migrations, never against
the app data, and with no secret. It never calls an integration.

## 8. Schedules and webhooks

**Schedules.** The descriptor lists them: a name, an interval or a cron
expression with a time zone, a mutation, and its input. The trigger type and
its math are the automations' (`AutomationTrigger`,
`data/automations/automation-schedule.ts`). The state is the app's:
`AppSchedule` rows and one timer in `apps/app-schedules.ts`, with the same
rules as the automation scheduler: one timer for the earliest due row, a wait
of at most five minutes, one overdue run after the host was off, and no second
run while one is in progress. A new schedule is on. The owner pauses it and
turns it on in the app's menu. A schedule whose declaration is gone from the
active version is deleted. A failed run stays in
the call log and does not retry.

An app schedule is not an automation. An automation starts an agent turn; an
app schedule runs code and costs nothing.

**Webhooks.** The descriptor lists them: a name, a verification, and a
mutation.

```ts
webhooks: {
  issueOpened: {
    verify: { scheme: 'hmac', header: 'x-hub-signature-256', prefix: 'sha256=' },
    run: 'onIssue',
  },
},
```

A webhook gets a fourth action beside "start a session", "send a prompt", and
"run an automation": **call an app mutation**. A deploy makes one webhook
record for each declaration, owned by the app, with that one action. The
mutation's input is `{ headers, query, body }` of the request. The URL, the
verification, the replay key, the deliveries log, replay, pause, and holding
while offline are the webhook owner's and do not change. The secret of a
webhook is made by the host and shown once in the app's menu, with the URL.
A declaration that is gone from the active version deletes its record. The
person can also make a webhook by hand with the same action.

**Always on.** A desktop host runs schedules only while Solus is open. A
standalone server or a cloud machine is the host for an app that must run all
day. The app's header says which of these its host is.

## 9. In Solus

**Why the app frame and not the browser pane.** The browser pane is a native
web view only on a desktop client whose host is the same machine. On web and
on mobile it is a streamed picture of the host's browser: text selection,
input methods, scrolling, and latency are the host's, not the device's. The
app frame is a frame in the client's own page on every client. It takes the
live theme, so an app has no seam with the workspace, and its calls go through the
typed RPC layer over IPC and WebSockets alike. An app has no URL in this
release (§12), so there is nothing for the browser pane to open.

The frame is the third model's: a window of a fixed size that the UI scrolls
inside, in standards mode, with no network but the declared hosts and the
bridge `window.solusApp.call`.

**An app is a product, on the workspace's surfaces.** The rule: an artifact
matches the theme of Solus, and an app gives the agent creative liberty with
the design. A render in a reply
takes the render palette and a 14px root. An app frame takes the workspace's
own chrome for its neutral tokens (`APP_NATIVE_STYLE` in
`@solus/contracts/artifact-sandbox`): `--border`, `--input`, `--ring`,
`--muted`, `--primary`, `--sidebar`, and `--radius` are the values
`workspace.css` gives its own controls, and the root is 16px, so a size in
`rem` is what it says. The app's background, hairlines, and text then match
the pane around it in light and dark mode. The rest is the app's own: its
wordmark, its accent color (`light-dark()`, because the frame's
`color-scheme` follows the theme), its type scale, its icons, its navigation,
and its controls. The skill's chapter asks for the design of a shipped
product ("Design a product"), and it allows a design skill.

A kit of controls was tried twice and removed twice. The second one, in the template
(`@solus/ui`) with rules to use it for every control, 14px text only, and no
identity gave apps that worked and looked like a form over a database: a
person compared one with an app an agent built with no skill, and the app
with no skill was the better product. A kit and strict rules set a low
ceiling; a brief and a preview to judge set a high one: in a trial, the same
request with the new chapter gave an app with a wordmark, an accent, a
sidebar, sample data, a detail view, and an export, in light and dark mode.

Two changes to the third model's frame: the client decides that a frame is
an app frame because it shows an app, not from a block in the page; and the
bridge gets events (`solus-app-event`) for live refresh.

Surfaces, on desktop, web, and mobile:

| Surface | What it shows |
|---|---|
| **Apps tab** of the Workspace page | The apps of every connected host, as cards: name, host, active version, the session it came from, last call, and what needs attention (a failed version, a secret that is not set, a failed schedule, stopped). The search, the sort, and the project and time facets apply. `⌥4` opens the tab. |
| **App** (`app`, a destination or a surface) | The app frame in all of the pane, under a thin header: name, version, and a menu. |
| **App menu** | Versions (the source diff to the one before, and **Make active**), Schedules (pause, turn on, run now, last outcome), Secrets (set, clear), Calls (the call log), Sessions (the linked sessions), Source (clone path), Stop or Start, Delete. |
| **Conversation** | A deploy opens the app's surface beside the conversation that made it, when that conversation is on screen (`apps.changed` names the session). The turn's chips name the app. The app's window is not drawn inside the transcript. |
| **Artifacts surface, session chips, turn chips** | An app the session linked, as one more kind. A row or a chip opens the app's surface. |
| **Mobile** | An Apps list (the phone has no Workspace page), the app in a full-screen web view, the header actions in a sheet, and the app chip in the thread. |

Entry points: the Workspace page, the command palette ("Apps", "Open app…"),
the chips of a turn and of a session card, a session's Artifacts surface, and
a link `/app/<slug>`. Each way in has its way back: deploy
and make active, stop and start, pause and turn on, set and clear, link and
unlink, create and delete.

An app with no UI has no frame: its surface shows its operations, with a form
to run one, as Settings → Tools does for an integration tool.

## 10. Server

`packages/server/src/apps/` owns the domain. Data never imports it.

| File | Owns |
|---|---|
| `data/apps/` | The four records and their scope rules. |
| `apps/apps.ts` | `Apps`: `deploy`, `activate`, `call`, `read`, `list`, `stop`, `start`, `delete`. |
| `apps/app-repository.ts` | The two commits of a deploy and the reads of a version's files, over `WorkRepositoryAccess`. |
| `apps/app-project.ts` | An app project as a deploy reads it: the build in `dist/app/` and the source files. |
| `apps/app-runners.ts`, `app-runner-script.ts` | The runner (§6). |
| `apps/app-schedules.ts` | Schedule rows and the timer (§8). |
| `apps/app-webhooks.ts` | The webhook records of the webhooks an app declares (§8). |
| `apps/app-secrets.ts` | The app's secrets in the host's secret store (§4.4). |
| `apps/app-events.ts` | `apps.changed` and `apps.dataChanged`. |
| `apps/app-storage.ts` | Storage, and the app's data folder. |
| `transport/handlers/app-handlers.ts` | `appList`, `appRead`, `appUi`, `appCall`, `appStop`, `appStart`, `appDelete`, `appVersions`, `appVersionDiff`, `appActivate`, `appSchedules`, `appScheduleSet`, `appScheduleRun`, `appSecretSet`, `appWebhooks`, `appCalls`, `appSessions`; the events `apps.changed` and `apps.dataChanged`. |
| `execution/agents/tools/app-tools.ts` | `deploy_app`, `preview_app`, `checkout_app`, `list_apps`, and the operations of running apps as tools. |
| `data/sessions/session-artifacts.ts`, `session-link-tools.ts` | The kind `app` in a session's links and its artifact list. |

Reused, not copied: the artifact frame and preview, the `visual-artifacts`
project and bundler, the integration gateway for an app's calls to
integrations, the host's secret store, the automations' trigger math, and the
webhook owner. The repository follows the conventions of a work's local
repository (`sync/works/local-work-repositories.ts`); the Cloudflare target
is later (§12).

Removed: the app manifest and its readers in `contracts/src/apps.ts`,
`app-content.ts`, `app-permissions.ts`, host access and `AppAccessBar`, the
write prompt in `client-core/app-calls.ts`, the app meta on a work,
`create_app`, the manifest step of
`bundle-artifact.mjs`, and the app branches in `ArtifactView`,
`ArtifactShell`, and `ThreadArtifact`.

## 11. What was built

All five steps of the build order are done: the app record with deploy,
versions, the runner, SQLite, storage, and live refresh; operations as agent
tools and the call log; secrets; schedules and webhooks; versions in the UI
with the source change of each one.

Left out, each for a reason:

- **No form to run an operation of an app with no UI.** Its surface lists the
  operations. An agent or a schedule calls them.
- **The header does not say if the host runs all day.** No fact a client reads
  tells a desktop host from a server.
- **The app's window is not drawn in the transcript** (§9). A deploy opens the
  app beside the conversation, and the turn's chips name it.
- **On a phone** a deploy does not open the app by itself, and there is no
  link `/app/<slug>`: the chip in the thread opens the app. The Apps list is
  reached from Settings and from a host's settings, not from a tab of its own.
  The source change of a version is desktop and web only.
- **An organization session** cannot link an app: the Solus API holds no app
  links (§12).
- **The Calls section** reads again when the app's data changes, not on each
  call: no event names a call that changed nothing.

## 12. Later

- **The cloud copy.** The Cloudflare Artifacts target for an app's repository,
  and "install this app on another host" from that copy. The repository access
  is shared with works, so this is configuration and a move flow, not a new
  store.
- **A URL for an app.** The host serves the UI at its own address for a normal
  browser and for the browser pane, with a sign-in. It needs an origin of its
  own for each app, or a sandboxed document with a token for its calls, and it
  must work through the tunnel.
- **Other people.** An app for a second person needs a runtime that is a real
  boundary (an isolate or a container for each app), an audience for each app,
  and secrets that belong to the app and not to its owner. Until then an app
  is the owner's.
- **Accounts.** Executor's reusable accounts: one saved credential that several
  apps use. A secret belongs to one app in this release.
- **The source as a project.** Open an app's repository as a Solus project,
  with sessions, worktrees, and diffs, and deploy from a commit.

## 13. Decided

Decided 2026-11-12 by the maintainers, after the first draft of this model:

- No approval for an operation, no `writes` permission, and no Allow for a
  version (decisions 7, 11, and 14).
- Apps link to sessions (18), and the Workspace page lists apps (19).
- App schedules are the app's own and show in its menu, not on the
  Automations page (§8).
- An app declares its webhooks; the webhook owner runs them and the person
  copies the URL (15). Executor's `register`, `handle`, and `unregister`
  callbacks are not taken: the Solus webhook owner already checks the
  signature, removes duplicates, logs, replays, and holds requests.
- The third model is removed in step 1 (17).

## 14. The earlier models

**First, 2026-11-11.** A work type `app` whose content was one TSX component,
run in a prebuilt shell inside the MCP App frame. An app was UI over
integration tools.

**Second, same day, never merged.** The component or a bundle from a separate
`apps` skill, with storage, network, and host functions, still in the shell.

**Third, 2026-11-11 to 2026-11-12, on `main`.** An app was an `artifact` work
whose page carried an app manifest: permissions, roles, a server module, and
sources. It gave an app the artifact pipeline, the app frame, storage, the
runner, and host access. All of those stay but host access.

The third model was replaced because the page was the whole app. Its code ran
only for its own page and only while the page was open, its data was one
key-value file, its source was a JSON field in a built page, and an agent
could not call it. A personal cloud needs the opposite of each.
