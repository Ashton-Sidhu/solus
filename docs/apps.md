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
| Models | Calls to a model that you choose in Config. The app's UI shows a call as it runs. |

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
- **The sidebar**: an app you pin shows in the places column, below the
  divider. Pin it from the app's menu or with a right-click in the column
  (`docs/plans/sidebar-places-and-sky.md`). Desktop and web only.
- **An app's surface**: the UI in all of the pane. The **App** and **Manage**
  switch in its header opens the Manage page. `⌥G` switches between the two.
- **A session**: the session that deployed an app is linked to it. The app is
  in the session's Threads surface and in the chips of the turn.
- **Command palette**: "Apps", "Open app…", and "Manage app…".
- **Mobile**: the Apps list, the app full screen, and its Manage screen.
- **An agent**: ask it. The tools are `save_app`, `deploy_app`, `preview_app`,
  `checkout_app`, `list_apps`, `inspect_app`, `retry_app_run`, and
  `set_app_signal_action`.

## The Manage page

Everything you do to an app is on its Manage page:

| Section | What you do there |
| --- | --- |
| Overview | See the app as the sidebar shows it, what needs you, whether it runs, its calls of the last 24 hours, its recent failures, its recent deploys, its schedules, what it may use, and its source: who made it, the project folder, the sessions that worked on it, the slug, the repository, and the newest revision. Stop it, start it, pin it, open it, rename it, describe it, give it a colour, or delete it. |
| Activity | Read the call log of operations and model calls. Search it, filter it, and see the calls over time. Open one call for its log lines, its input, its trace, and its error. Open a model call for its prompt, what the model wrote, and its result, and cancel it. |
| Workflows | See each run and its steps. End a run. Start a failed run again. |
| Versions | See what runs now, the change log of the source, and the deploy history with each rollback. Deploy a revision. Roll back or forward to a version. Read a build log. |
| Schedules | Pause a schedule, turn it on, run it now. |
| Webhooks | Copy a webhook's URL and its signing secret. |
| Signals | Decide what each signal does. See what the app emitted. |
| Secrets | Set a secret or clear it. |
| Config | Change a setting, or reset it to its default. |
| Files | Upload, download, and delete app files. |
| Operations | Run an operation by hand. Turn agent access off or on. |
| Sessions | Open a session that made or changed the app. |
| Source | The slug, the repository, and Delete. |

The app's header uses the same pills as the other panes: the app's name, a
**Start** button while the app is stopped, the **Manage** button, and the app
menu. While the app has a problem, the icon of **Manage** is an alert: red when
a part of the app does not work (a version that failed, a schedule or a
workflow whose last run failed), amber when the app only waits for a secret.
Solus draws nothing over the app for a problem.


### Name, description, and colour

An app's manifest names and describes it, and each deploy writes them again.
On the Overview you can give the app your own name and description, and pick
the colour of its tile in the sidebar. The host keeps them apart from the
manifest (`custom_name`, `custom_description`, and `color_hue` on the app
record), so a deploy does not undo them. Reset, an empty field, or the
manifest's own text goes back to the manifest. An app with no colour of its own
takes one from its id. The name and the colour are the same for every person
and every client of the host. The slug does not change. The method is `appUpdate`,
and mobile has the same controls.

## Revisions and versions

A **save** commits the app's source as a **revision**. It changes nothing that
runs. A **deploy** has the host build one revision and makes the result, a
**version**, active at once. A version is immutable.

- The host builds what it runs. A build that fails makes a failed version with
  its build log, and the version before it continues to run.
- A version whose migration is refused, or whose backend does not start, is
  also recorded as failed. Its migrations apply whole or not at all, so the
  version before it runs on the schema it had.
- A **rollback** makes an earlier version active again, and a **roll
  forward** makes a newer one active again. Neither rebuilds, and neither
  rewinds the app's data. You confirm each one.
- You can deploy a saved revision from the Versions section, with no agent.
- Two sessions cannot overwrite each other. A save from a folder that came
  from an older revision is refused, and the message says which revision is
  newer.

### The Versions section

The section has three parts, on desktop, web, and mobile:

- **Running now.** The live version, since when and by whom it runs, its
  revision, and its build. Under it: a build in progress, a rollback (with
  the control to roll forward to the newer build), and the saves that do not
  run (with **Deploy the newest**).
- **Change log.** Every save of the source on one line of descent, the newest
  first, grouped as *Not running*, *Running now*, and *Earlier*. Each save
  shows its revision, when it was saved, how many files and lines it changed,
  and the versions built from it. A save with no build that ran can be
  deployed. A save with a build that ran rolls back or forward to that build.
- **Deploys.** What ran when: each deploy, rollback, and roll forward with who
  did it and the version it replaced, and each build that failed. A rollback
  opens the source change it made: the revision it left against the revision
  it went back to.

Each version keeps every time it became active (the newest 50), so the
history of rollbacks survives a restart.

`deploy_app` is a tool that needs approval, so your session's permission mode
decides whether you see a deploy first. `save_app` needs none: a save runs
nothing. An app has no more rights than the session that deployed it.

## What an app may use

An app declares the network hosts it reaches and the host paths its backend
reads and writes. The Versions section says them in one sentence for the
version that runs. Solus refuses a host or a path that the app did not declare. The
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

A model call is a row of the same log, marked with a sparkle beside the name
of its model setting. Its row keeps the prompt as its input and what the model
wrote as its log line, so the search finds both. It opens on the call itself:
the prompt, the operations the model called, what it wrote, and its result,
with Cancel while it runs. Each operation the model called is a row of its own,
with the caller "A model call".

The search finds text in the operation, the caller, the error, the input, and
the log lines of each call that the host keeps, in any case. The filters narrow
the log by operation, caller, and outcome. On desktop and web, the log is a
list: each row has a mark for how the call ended, the operation, the caller,
the time it took, and when it started. The order menu shows the newest, the
oldest, or the slowest calls first, and **Show more** adds rows. At the top of
the list, the Insights trend chart shows the time of each call in view, with
the failed calls marked; click a point to open its call. The arrow keys move
between the rows. A call opens on its log lines when it wrote any, and its
trace shows in the Insights waterfall.

The Manage page uses one set of marks for how a thing stands, on a call, a
run, a step, a version, and a signal action: a check for one that ended well,
a cross for one that failed, a dashed circle for one that runs, a moon for one
that sleeps, a pause for one that is paused, and a warning triangle for one
that needs you. A name, a slug, and a revision use the normal font. Only a
block of machine text (JSON, a log, a stack, a diff) uses the code font.

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

The **Files** section lists every app file: its type, where it came from (an
upload, or the agent, schedule, webhook, workflow, or model call that wrote it),
its size, and when it was added. Three figures at the top give the number of
files, their total size, and the newest one. You can search by name or type,
show only uploaded files or only files the app wrote, and sort by date, name,
or size. To upload, use **Upload files** or drop files anywhere on the section.
Each row can download its file, copy its id (the backend reads a file with
`files.get(id)`), or delete it after you confirm. On a phone, a row can share
its file, copy its id, or delete it.

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
  steps do not. Each run shows the version that ran it.

### A run that failed on an older version

A deploy does not start a failed run again. When the last run of a workflow
failed on a version that no longer runs, the problem is not the code that runs
now: the work waits. **Needs you** on the Overview shows it as a warning, not
an error: "The last sync run failed on v1. v5 has not run it yet." It has two
buttons:

- **Retry on v5** starts the run again on the active version.
- **Dismiss** takes it off the list. The run stays in **Workflows**, marked
  Dismissed. Retry is still there.

On mobile, the row opens the run, which has **Run again** and **Dismiss**.

An agent that deploys a fix sees these runs in the answer of `deploy_app`. It
starts them again with `retry_app_run` and checks that they succeed before it
says the app is fixed.

A failed schedule on an older version is not a problem: the schedule runs again
by itself on the active version.

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

## Models

An app can ask a model for an answer: a summary, a classification, an
analysis. The app names a model setting, and you choose its model under
**Config**. An empty setting uses the model Solus writes with.

- The app's UI shows the call while it runs: what the model writes, each
  operation of the app it uses, and the result. It can cancel the call.
- The model can use only the operations of the app that the call names. It
  has no files, no shell, and no integrations.
- Two calls of an app run at once. The others wait.
- A call runs with this host's sign-in to the provider, so you pay for it.
  A model call in the **Activity** section shows its tokens.
- A call that is running when the host stops fails. The app can start it
  again.
- If the host cannot run the model you chose, the call fails and says so.
  Choose another model under **Config**.

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

**Config** lists the settings the app declares in one card, each with its
value and the name the app reads it by. A switch or a choice saves at once. On
desktop and web, text and a number save when you leave the field or press
Enter, and Escape drops what you typed; on mobile, tap the row and then
**Save**. A setting you changed says **Changed** and names its default; the
reset button (**Reset** on mobile) gives it its default again. A change applies
at once: the backend uses the new value from its next call, and the open app reads
it again. A value is not a secret: the app's UI shows it, and an agent reads it
with `inspect_app`. Only you change it.

When a new version changes a setting so that your value no longer fits it, the
app uses the default until you set a new value.

## Publish

An app runs in Solus, for you and your agents. **Publish** runs a copy of its
active version in a container of its own, with an address that a browser
opens. Use it to give the app to people who do not have Solus. Publish from
the **Deployment** section of the Manage page, or ask an agent; it uses
`publish_app`.

The Deployment section shows how the copy is, its address, and the link to
give a person. It says when a newer version is active in Solus, and
**Publish version N** sends it. You change who opens the app and what a
visitor does there, make a new link, read the log of the container, and
unpublish.

Who opens the copy:

- **People with the link.** A publish gives you a link, and only a person who
  has it opens the app. A new link puts each earlier visitor out.
- **People you name.** You, and the people, the teams, and the organization
  that you name, each with what they may do. Each one signs in to Solus at
  the address. A person you did not name does not get in, and the app does
  not learn who they are. This needs you signed in to Solus on the host of
  the app. You make the list on desktop or on the web.
- **Everyone.** Each person who has the address opens the app.

Where the copy runs:

- **Docker on the host of the app.** The address is a port of that host. Turn
  on **Tailscale address** for an HTTPS address on your tailnet that your
  other devices open. Set the Tailscale auth key of the host first, in
  Settings on the host's page. The host downloads the runtime image at its
  first publish.
- **Docker on another host of yours.** The section lists the hosts that the
  app's host reaches for you. The container runs there, and the app stays
  where it is.
- **Solus Cloud.** The copy runs while each host of yours is off, and sleeps
  when nobody uses it. Not open yet: Solus Cloud needs a domain for apps
  (`docs/plans/app-deploy.md` §8.3).

The section says what a place lacks before you publish: Docker that does not
run, or no sign-in to Solus.

A copy stays in its place. To put it in another place, unpublish it and
publish again; the data of the copy does not go with it.

- **The app in Solus does not change.** The copy has its own data. A deploy in
  Solus does not reach the copy: publish again to send a new version.
- **A visitor is not you.** A visitor can use only the connections that the
  app names as its own (`appIntegrations`), and acts with them through the
  app. A visitor never acts with your other connections.
- **A model call of the copy runs on the host of the app,** with your model
  account, for each visitor who starts one. The app's own code must guard it.
  You read each call in Activity.
- **A webhook of the app has one more URL** for the copy, in the Deployment
  section, with the same signing secret.
- **The app's secrets** go to the copy when you publish. Publish again after
  you change one.
- **The app and its copy each run the app's schedules.** Stop the app in Solus
  when only the copy must run them.
- **Unpublish** removes the copy with its data. It cannot be undone.

Ask an agent to **export**
the app (`export_app`) for an image that you run on a platform of your own,
with no Solus. See `docs/plans/app-deploy.md`.

## Stop and delete

**Stop** stops the backend, every schedule, and every run. The UI still opens,
and an operation fails with a message that says the app is stopped. **Start**
reverses it, and the runs that waited continue.

**Delete** removes the app with its repository, its data, its files, its
schedules, its runs, its signals, its secrets, its webhooks, and its links to
sessions. It cannot be undone.

## Limits

- An app is its host owner's. It cannot be shared with another person yet.
- An app in Solus has no URL for a normal browser. A published copy has one (see Publish).
- A member's organization session on the Solus API cannot link an app.
- The source change of a version is on desktop and web only.
- A workflow step runs at least once, not exactly once.
- The host builds an app with `npm` and Node 22 or later. A host with no
  `npm` on its path cannot deploy.
