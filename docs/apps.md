# Apps

An app is a small program that lives on a host. A person asks an agent for
one, and the agent writes it, saves it, and deploys it. An app has a backend,
its own data, and a UI. It works when nobody looks at it. The design is in
`docs/plans/apps.md`.

## What an app has

| Part | What it is |
| --- | --- |
| Operations | Typed queries and mutations. A query reads. A mutation writes. |
| Data | The app's own SQLite database, on the host. |
| App files | Files you give the app in its UI, and files its backend writes. |
| UI | A full application in its own window, with as many pages as it needs. An app can have no UI. |
| Workflows | Work that is longer than one call: steps that the host keeps, retries, and sleep. |
| Schedules | A timer that runs a mutation with no person there. |
| Webhooks | A URL that another service calls. It runs a mutation. |
| Signals | Events the app emits. You decide what each one does. |
| Secrets | Values you give once, such as a database URL. Only the backend reads them. |
| Config | Settings you change, such as an hour or a team. The backend and the UI read them. |

Five callers use the same operations: the app's UI, an agent, a schedule, a
webhook, and a workflow of the app.

## Where apps live

An app is a record on the host that runs it. Its source and every build are in
a git repository under the host's data folder, at
`apps/repositories/app-<hash>.git`. Its data is at `apps/data/<app id>/`. Only
the owner of the host uses an app.

You find apps in these places:

- **Workspace page → Apps**: the apps of every connected host, each with its
  state, its calls of the last 24 hours, and what needs you.
- **An app's surface**: the UI in all of the pane. The **App** and **Manage**
  switch in its header opens the Manage page. `⌥G` switches between the two.
- **A session**: the session that deployed an app is linked to it. The app is
  in the session's Artifacts surface and in the chips of the turn.
- **Command palette**: "Apps", "Open app…", and "Manage app…".
- **Mobile**: the Apps list, the app full screen, and its Manage screen.
- **An agent**: ask it. The tools are `save_app`, `deploy_app`, `preview_app`,
  `checkout_app`, `list_apps`, `inspect_app`, and `set_app_signal_action`.

## The Manage page

Everything you do to an app is on its Manage page:

| Section | What you do there |
| --- | --- |
| Overview | See whether the app runs, its problems, and its calls of the last 24 hours. Stop it or start it. |
| Activity | Read the call log. Open one call for its input, its log lines, its trace, and its error. |
| Workflows | See each run and its steps. End a run. Start a failed run again. |
| Versions | See each save and each version. Deploy a revision. Make an earlier version active. Read a build log. |
| Schedules | Pause a schedule, turn it on, run it now. |
| Webhooks | Copy a webhook's URL and its signing secret. |
| Signals | Decide what each signal does. See what the app emitted. |
| Secrets | Set a secret or clear it. |
| Config | Change a setting, or reset it to its default. |
| Files | Upload, download, and delete app files. |
| Operations | Run an operation by hand. Turn agent access off or on. |
| Sessions | Open a session that made or changed the app. |
| Source | The slug, the repository, and Delete. |

The app's header has a dot on **Manage** while the app has a problem: red when
a part of the app does not work (a version that failed, a schedule or a
workflow whose last run failed), amber when the app only waits for a secret.
Solus draws nothing over the app for a problem.

## Revisions and versions

A **save** commits the app's source as a **revision**. It changes nothing that
runs. A **deploy** has the host build one revision and makes the result, a
**version**, active at once. A version is immutable.

- The host builds what it runs. A build that fails makes a failed version with
  its build log, and the version before it continues to run.
- A version whose migration is refused, or whose backend does not start, is
  also recorded as failed. Its migrations apply whole or not at all, so the
  version before it runs on the schema it had.
- **Make active** runs an earlier version again. It does not rewind the app's
  data.
- You can deploy a saved revision from the Versions section, with no agent.
- Two sessions cannot overwrite each other. A save from a folder that came
  from an older revision is refused, and the message says which revision is
  newer.

`deploy_app` is a tool that needs approval, so your session's permission mode
decides whether you see a deploy first. `save_app` needs none: a save runs
nothing. An app has no more rights than the session that deployed it.

## What an app may use

An app declares the network hosts it reaches and the host paths its backend
reads and writes. The Versions section says them in one sentence for each
version. Solus refuses a host or a path that the app did not declare. The
app's own database and files need no permission.

An app also names the integrations it calls. Each call uses the caller's own
connection. A schedule, a webhook, and a workflow use the owner's connection.
An MCP integration from Settings → MCP gives its tools. The names `github`,
`atlassian` (Confluence and Jira), and `google` (Google Drive) give the
built-in connections from Settings → Integrations when you have no MCP
integration with that name. A built-in connection has one tool, `request`,
which sends one call to that service's API. Solus adds your sign-in to the
call, so the app never gets your token. The Overview section shows whether
you are connected to each integration that the app names.

The backend runs in a child process of the host, under Node's permission
model. This is a guard, not a jail: an app is your own code on your own host.

## Calls and what Solus keeps of them

An operation never asks you first, from any caller. An agent's call follows
its session's permission mode, as the tool of any integration does.

The **Activity** section is the call log. For each call Solus keeps the
operation, the caller, the time it took, how it ended, at most 16 KiB of its
input, the lines its code logged, and its trace: each request to a network
host (the method and the host, never the path), each integration tool, the
SQL total, each file, and each signal. Solus never keeps a result or a secret.
The log keeps the newest 2,000 calls of each app.

Each call is also an OpenTelemetry trace. Insights has it: the span kinds are
`app_call`, `app_run` (one execution of a workflow), and `app_work` (each
thing a call waited for), and the lines the code logged are log events. When
you turn on the export in **Settings → Telemetry**, the same spans go to your
collector with the standard attribute names, for example
`http.request.method`, `server.address`, and `http.response.status_code` for
a request, and an `exception` event for a failed call. The metrics
`app_call_duration` and `app_calls_total` go with them when the export of
metrics is on. The call detail shows the trace id; copy it to find the call
at the collector. Solus adds no `traceparent` header to a request that an
app's code sends.

When a mutation changes the app's data, every open UI of the app reads again.
So a change that an agent or a schedule makes shows in the UI.

## App files

An app's UI can take a file from you: its own file chooser or a drop target.
The file goes to the host in parts and the backend reads it. The backend can
also write a file, and the UI can give you one: a download on a computer, the
share sheet on a phone. One file is at most 64 MiB.

The **Files** section lists every app file. You can upload one, download one,
and delete one there.

## Workflows

A call has 60 seconds (an operation can ask for up to 15 minutes). A workflow
is for longer work, and for work that must not be lost. The host keeps the
result of each step. After a deploy, a stop, or a restart of the host, a run
continues from the step it was at.

- A step can run again after it failed, as many times as the app says.
- A run can sleep for hours. It holds no process while it sleeps.
- A step that was in progress when the host stopped runs again. Solus does not
  promise that a step runs exactly once.
- A run of a stopped app waits until you start the app.
- In **Workflows** you see each run and its steps, you can end a run, and you
  can start a failed run again: its failed step runs again and its finished
  steps do not.

A desktop host wakes a sleeping run only while Solus is open.

## Signals

A signal is how an app says that something happened, such as "a report is
ready". A signal does nothing by itself. In **Signals** you decide what each
one does:

| Action | What it does |
| --- | --- |
| Notify | One notification for you, in the notification hub. It opens the app. |
| Send to a session | A prompt to one session. |
| Run an automation | One run of an automation. Use this to start a new session: the automation holds the agent, the model, and the folder. |

A new signal gets a Notify action, turned on. An agent can add an action with
`set_app_signal_action`, which needs approval. An action that starts agent
work runs at most 30 times in one hour; after that, the occurrence says
"throttled". The section shows the newest occurrences and how each action
ended.

## Agents

Each operation of a running app is a tool in every run that starts after the
deploy. Its name is `<slug>__<operation>`. Ask an agent to use the app by its
name. **Operations → Agent access** turns this off and on for one app.

To change an app, ask an agent. It gets the source with `checkout_app`,
changes it, saves it, and deploys a new version. To repair an app, an agent
reads the call log, the runs, and the build logs with `inspect_app`.

## Schedules

A schedule is on from the deploy that declares it. In **Schedules** you can
pause it, turn it on, and run it now. The section shows the next run and how
the last run ended. A run that fails does not retry; an app that must not lose
the work starts a workflow from the schedule's mutation.

A desktop host runs schedules only while Solus is open. After the host was
off, a schedule that was due runs one time. Use a standalone server or a cloud
machine for an app that must run all day.

## Webhooks

An app that declares a webhook gets a webhook record when it is deployed.
**Webhooks** shows the URL and the signing secret. Copy both into the other
service. When the other service gives its own secret, set it in Settings →
Webhooks. The deliveries log, replay, pause, and holding while the host is
offline are those of every webhook (`docs/webhooks.md`).

You can also make a webhook by hand with the action **call an app mutation**.

## Secrets

**Secrets** lists the secrets the app declares and says which are set. Set a
value there. Solus never shows a value again. The values are in the host's
secret store, not in the app's data.

## Config

**Config** lists the settings the app declares, each with its value and its
default. A switch or a choice saves at once; text and a number save with
**Save**. **Reset** gives a setting its default again. A change applies at
once: the backend uses the new value from its next call, and the open app reads
it again. A value is not a secret: the app's UI shows it, and an agent reads it
with `inspect_app`. Only you change it.

When a new version changes a setting so that your value no longer fits it, the
app uses the default until you set a new value.

## Stop and delete

**Stop** stops the backend, every schedule, and every run. The UI still opens,
and an operation fails with a message that says the app is stopped. **Start**
reverses it, and the runs that waited continue.

**Delete** removes the app with its repository, its data, its files, its
schedules, its runs, its signals, its secrets, its webhooks, and its links to
sessions. It cannot be undone.

## Limits

- An app is its host owner's. It cannot be shared with another person yet.
- An app has no URL for a normal browser yet.
- A member's organization session on the Solus API cannot link an app.
- The source change of a version is on desktop and web only.
- A workflow step runs at least once, not exactly once.
- The host builds an app with `npm` and Node 22 or later. A host with no
  `npm` on its path cannot deploy.
