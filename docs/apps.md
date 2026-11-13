# Apps

An app is a small program that lives on a host. A person asks an agent for
one, and the agent writes it and deploys it. An app has a backend, its own
data, and a UI. It works when nobody looks at it. The design is in
`docs/plans/apps.md`.

## What an app has

| Part | What it is |
| --- | --- |
| Operations | Typed queries and mutations. A query reads. A mutation writes. |
| Data | The app's own SQLite database and a files folder, on the host. |
| UI | A full application in its own window, with as many pages as it needs. An app can have no UI. |
| Schedules | A timer that runs a mutation with no person there. |
| Webhooks | A URL that another service calls. It runs a mutation. |
| Secrets | Values you give once, such as a database URL. Only the backend reads them. |

Four callers use the same operations: the app's UI, an agent, a schedule, and
a webhook.

## Where apps live

An app is a record on the host that runs it. Its source and every build are in
a git repository under the host's data folder, at
`apps/repositories/app-<hash>.git`. Its data is at `apps/data/<app id>/`. Only
the owner of the host uses an app.

You find apps in these places:

- **Workspace page → Apps**: the apps of every connected host.
- **An app's surface**: the UI in all of the pane, with a menu.
- **A session**: the session that deployed an app is linked to it. The app is
  in the session's Artifacts surface and in the chips of the turn.
- **Command palette**: "Apps" and "Open app…".
- **Mobile**: the Apps list, and the app full screen.
- **An agent**: ask it. The tools are `deploy_app`, `preview_app`,
  `checkout_app`, and `list_apps`.

## Versions

A deploy makes a version and makes it active at once. A version is immutable:
a source commit and its build.

- A version whose backend does not start, or whose migration fails, is
  recorded as failed. The version before it continues to run. The app shows
  why the version failed.
- **Make active** in the app's menu runs an earlier version again. It does not
  rewind the app's data.
- The menu shows the source change of each version against the one before it.

`deploy_app` is a tool that needs approval, so your session's permission mode
decides whether you see a deploy first. In full access a deploy runs with no
click. There is no second step: an app has no more rights than the session
that deployed it.

## What an app may use

An app declares the network hosts it reaches and the host paths its backend
reads and writes. Its header says them in one sentence. Solus refuses a host
or a path that the app did not declare. The app's own database and files
folder need no permission.

The backend runs in a child process of the host, under Node's permission
model. This is a guard, not a jail: an app is your own code on your own host.

## Calls

An operation never asks you first, from any caller. An agent's call follows
its session's permission mode, as the tool of any integration does.

The app's menu has **Calls**: which operation ran, for which caller, when, and
how it ended. The log keeps no input and no result. It keeps the newest 2,000
calls of each app.

When a mutation changes the app's data, every open UI of the app reads again.
So a change that an agent or a schedule makes shows in the UI.

## Agents

Each operation of a running app is a tool in every run that starts after the
deploy. Its name is `<slug>__<operation>`. Ask an agent to use the app by its
name.

To change an app, ask an agent. It gets the source with `checkout_app`,
changes it, and deploys a new version.

## Schedules

A schedule is on from the deploy that declares it. In the app's menu you can
pause it, turn it on, and run it now. The menu shows the next run and how the
last run ended. A run that fails does not retry.

A desktop host runs schedules only while Solus is open. After the host was
off, a schedule that was due runs one time. Use a standalone server or a cloud
machine for an app that must run all day.

## Webhooks

An app that declares a webhook gets a webhook record when it is deployed. The
app's menu shows the URL and the signing secret. Copy both into the other
service. When the other service gives its own secret, set it in Settings →
Webhooks. The deliveries log, replay, pause, and holding while the host is
offline are those of every webhook (`docs/webhooks.md`).

You can also make a webhook by hand with the action **call an app mutation**.

## Secrets

The app's menu lists the secrets it declares and says which are set. Set a
value there. Solus never shows a value again. The values are in the host's
secret store, not in the app's data.

## Stop and delete

**Stop** stops the backend and every schedule. The UI still opens, and an
operation fails with a message that says the app is stopped. **Start**
reverses it.

**Delete** removes the app with its repository, its data, its schedules, its
secrets, its webhooks, and its links to sessions. It cannot be undone.

## Limits

- An app is its host owner's. It cannot be shared with another person yet.
- An app has no URL for a normal browser yet.
- A member's organization session on the Solus API cannot link an app.
- The source diff of a version is on desktop and web only.
