---
name: create-app
description: Build, change, verify, or repair a Solus app with agent tools, a UI, data, integrations, or background work. Use for tools, trackers, data browsers, and apps that run on a schedule or webhook. Start new apps from the checked starter.
---

# Build an app

An app is a small program that lives in Solus, on the user's host. It has a backend, its own SQLite data, and a UI. It works when nobody looks at it: the user, their agents, a schedule, a webhook, and the app's own workflows all call the same operations.

Build whatever the user asked for, at the size they asked for. Do not reduce the request to one screen, or to what one data source offers.

| Part | Where | What it is |
|---|---|---|
| Operations | `app.ts` | Typed queries and mutations. The UI calls them, and each one is a tool for an agent. |
| Data | `migrations/*.sql` | The app's own SQLite database. |
| App files | `@solus/app`, `ctx.files` | Files the user gives the app in the UI, and files the backend writes. |
| Workflows | `app.ts` | Work that is longer than one call: durable steps, retries, and sleep. |
| Schedules | `app.ts` | A timer that runs a mutation with no person there. |
| Webhooks | `app.ts` | A URL another service calls; it runs a mutation. |
| Signals | `app.ts` | Typed events the app emits. The user decides what one does: a notification, a prompt to a session, a run of an automation. |
| Secrets | `app.ts` | Values the user gives once, such as a database URL. Only the backend reads them. |
| Config | `app.ts` | Settings the user changes on the Manage page, such as an hour or a team. The backend and the UI read them. |
| Models | `ctx.models` | Calls to a model that the user chooses in Config. The UI watches a call as it runs. |
| Integrations | `app.ts` | The user's connected services, by slug. |
| UI | `src/` | A full application in its own window. An app can have no UI. |
| Storage | `@solus/app` | Key-value data for a UI that needs no backend. |
| Icon | `icon.svg` | The app's icon in Solus (the sidebar, its pane, the Apps tab, the command palette) and on its desktop shortcut. Without one, the app shows its first letter on a colour. |
| Menu-bar page | `menubar.html`, `src/menubar.tsx` | Optional: a small page in a popover under the app's menu-bar item on the desktop ([desktop.md](references/desktop.md#the-menu-bar-page)). |
| Desktop | `@solus/app` | In the app's own window of the desktop app: a menu-bar item, global shortcuts, notifications, clipboard read, system audio, a badge, and more, each with the person's permission. |

Each part is optional. A to-do list needs only a UI and `storage`. A database browser needs operations and access to its data source. A digest that posts each morning needs an operation and a schedule, and no UI. An importer needs an app file and a workflow.

## Choose what runs

Use an operation for work a person or agent starts. Add a schedule when time starts the work or a webhook when another service sends an event. Have the operation start a workflow when the job needs retries, a wait, or progress that survives a restart. Emit a signal when the app has something to report. Before you choose a background trigger, check [how it runs](references/triggers.md#choose-a-trigger) and [whose connection it uses](references/access.md#integrations).

## Check for an existing connection

If the app uses an external service, look for a Solus integration before you run the initializer. Confirm that an available integration can access the data the app needs, then reuse it. See [Check service access](references/access.md#check-service-access) for how to check the connection and when to use a direct API.

## Start from the starter

Resolve this skill's directory from the path used to load it. Node.js 22 or later and npm are required.

```sh
node "<skill-dir>/scripts/init-app.mjs" "<new-app-directory>"
```

Choose a new directory outside the user's project unless they asked to keep the source there; its parent must exist. The initializer refuses to replace an existing directory, and it installs only in the new directory.

The new project is a complete, checked app: **Notes**. Read all of it before you change it:

| File | What it shows |
|---|---|
| `app.ts` | Four operations with descriptions, input and output schemas, a search over SQL, and an error a person can act on; two config fields that the user changes. |
| `src/schema.ts` | The row schema that the backend and the UI share. |
| `migrations/0001_notes.sql` | The table and its index. |
| `src/App.tsx` | The window: a wordmark with a live status, a headline from config, a composer, a list of notes with search and a count, a detail page, a delete with a confirm `<dialog>`, a `/` shortcut, and the loading, empty, no-match, saving, and error states. |
| `src/route.ts` | Pages in the address after `#`. |
| `src/styles.css` | How a theme is set up: tokens in `@theme`, each with a light and a dark value from `light-dark()`. Its values are a sample for Notes. |

Make it into the app the user asked for. The starter has two kinds of parts:

- **Wiring to keep.** The type-only import of `app` in the UI, the shared schema, the operations' shape, the route by address, and the loading, empty, error, and saving states.
- **A sample to replace.** The look of Notes: its palette, its face, its wordmark, its single-column layout, and its headline. They are there to show that the wiring works, not as a house style. Write the app's own `@theme` values, shell, and components from the brief ([design](references/design.md)); do not change Notes' look a little at a time.

Do not keep a part of Notes that the new app does not need. A larger app gets a sidebar and more pages.

`@solus/app` and `@solus/app/backend` are files of the project (`src/solus-app.ts`, `src/solus-app-backend.ts`), not npm packages: import them, do not install them, and do not edit them.

## Build, verify, and deploy

1. For a new app, check access when applicable and run the initializer. For an existing app, use its current project folder or `checkout_app` and `npm install`. Read the current source and its [SDK types](references/backend.md#check-the-contract) before changing it. For a repair, [read the failed call or run](references/deploy.md#repair-an-app) first.
2. Read only the references that apply. Make the app's operations and data model fit its callers. For a UI, read [design](references/design.md) and write its brief before you build components.
3. Run `npm run check` and any focused behavior checks. Check the UI with `preview_app`, including its routes, a narrow window, and dark mode. Fix problems before you save.
4. Use `save_app` with the project path, then `deploy_app` with the app slug. Saving creates a revision. Deploying makes it active and links the app to the session. See [deployment](references/deploy.md#save-and-deploy) for version and publishing behavior.
5. [Verify the active app](references/deploy.md#verify-the-active-app) through its normal entry point when possible. Give the user the app, what it does, an example request for their agent, and any setup or behavior still to verify.

Use `preview_app` for app previews. The host builds the source it runs.

## Read only the topics you need

| Task | Reference |
|---|---|
| Design the app: identity, shell, states, the window, light and dark | [design.md](references/design.md) |
| Write `app.ts`: operations, `ctx`, errors, logs, the backend's runtime | [backend.md](references/backend.md) |
| Keep data: migrations, and `storage` for a UI with no backend | [data.md](references/data.md) |
| Write the UI: the client, pages, the window, the network | [ui.md](references/ui.md) |
| Take files from the user, or give the user a file | [files.md](references/files.md) |
| Choose a trigger, run on a timer, or receive a provider event | [triggers.md](references/triggers.md) |
| Report a result, notify the user, or hand work to an agent | [signals.md](references/signals.md) |
| Run a job with retries, waits, or progress that survives a restart | [workflows.md](references/workflows.md) |
| Let the user change a setting: config | [config.md](references/config.md) |
| Ask a model: a summary, a classification, an analysis | [models.md](references/models.md) |
| Use a secret, a connected service, the network, or the host's files | [access.md](references/access.md) |
| Preview, deploy, repair, or update an older app | [deploy.md](references/deploy.md) |
| Use the desktop app: a menu-bar item and its page, global shortcuts, notifications, a badge, keep on top, start at login, clipboard read, the microphone, the camera, or system audio | [desktop.md](references/desktop.md) |

## Done

Look at each preview as the user will: would a person take this for a product that a team shipped? If it reads as a form, a debug view, a default page, or Notes with new words, design it again before you deploy. Compare it with the brief. Show real data; never put a hard-coded array where live data belongs. Say which behavior you did not check.
