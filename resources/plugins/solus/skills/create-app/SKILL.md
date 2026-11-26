---
name: create-app
description: Build, change, and repair an app that lives in Solus — a tool, a tracker, a browser for the user's data, or something that runs on a schedule or a webhook — with a backend on the host, its own SQLite data and files, a UI in its own window, and operations that agents can call. Starts from a checked starter app. Read before you create or change an app.
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

Each part is optional. A to-do list needs only a UI and `storage`. A database browser needs operations, a secret, and a network permission. A digest that posts each morning needs an operation and a schedule, and no UI. An importer needs an app file and a workflow.

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

## Steps

1. Start the project with the initializer.
2. Design the app as a product before you write components: read [design](references/design.md) and write its brief.
3. Write the backend, the data, and the UI. Read only the topics the app needs (below).
4. Check it: `preview_app` with `path` (the project folder). The host builds the folder and gives you a screenshot. A build error comes back with the build's own text. Fix what you see. Check each page with `route`, and check about 390px wide and dark mode too.
5. Save it: `save_app` with `path`. A save commits the source as a revision and changes nothing that runs. The receipt says the app's slug.
6. Deploy it: `deploy_app` with `app: "<slug>"`. The host builds the revision and makes the version run at once. It links the app to this session.
7. Tell the user what the app does, what needs them (a secret, a webhook to register), and one thing to ask their agents to do with it ([deploy](references/deploy.md)).

To change an app later, edit the same folder, then `save_app` and `deploy_app` again. In a later session, get the source first with `checkout_app`, then `npm install`. To repair an app, read [deploy](references/deploy.md#repair-an-app) before you change code.

Do not use `render_artifact` for an app. `npm run bundle` checks the types and the build in your own shell, but the host builds what it runs: no tool reads the `dist/` it writes.

## Read only the topics you need

| Task | Reference |
|---|---|
| Design the app: identity, shell, states, the window, light and dark | [design.md](references/design.md) |
| Write `app.ts`: operations, `ctx`, errors, logs, the backend's runtime | [backend.md](references/backend.md) |
| Keep data: migrations, and `storage` for a UI with no backend | [data.md](references/data.md) |
| Write the UI: the client, pages, the window, the network | [ui.md](references/ui.md) |
| Take files from the user, or give the user a file | [files.md](references/files.md) |
| Run long or durable work: workflows | [workflows.md](references/workflows.md) |
| Run on a timer or on a call from another service, or tell the user that something happened | [triggers.md](references/triggers.md) |
| Let the user change a setting: config | [config.md](references/config.md) |
| Ask a model: a summary, a classification, an analysis | [models.md](references/models.md) |
| Use a secret, a connected service, the network, or the host's files | [access.md](references/access.md) |
| Preview, deploy, repair, or update an older app | [deploy.md](references/deploy.md) |

## Done

Look at each preview as the user will: would a person take this for a product that a team shipped? If it reads as a form, a debug view, a default page, or Notes with new words, design it again before you deploy. Compare it with the brief. Show real data; never put a hard-coded array where live data belongs. Say which behavior you did not check.
