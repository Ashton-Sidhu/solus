# Preview, deploy, and repair

## Preview

`preview_app` builds the project folder on the host, opens the UI in a window 800px tall, at the width you ask for (1100px by default), answers its calls, and takes a picture of the window. `route` opens one page. Nothing is saved or deployed, and it needs no approval.

- A build error comes back with the end of the build log: a type error, an import that does not resolve, a native add-on. Fix it and preview again.
- Operations run for real, against a new, empty database with the project's migrations. So the first picture shows the state of a first open. Sample rows that a migration adds are there; the user's own data is not. To see the app with real data, deploy; from your next turn each operation is a tool you can call.
- A preview is a picture of one route. It does not click or type. Give each state that matters a route (a page, a tab, an open detail view) so that you can check it, and say which behavior you did not check.
- A secret is not set in a preview, an integration is not called, a workflow does not start, and there is no app file. Design those states from the known shapes, and say that the live view was not checked.
- `storage` works in memory.

## Save and deploy

A project folder names its app and the revision it came from in `.solus/app.json`. `checkout_app` and `save_app` write that file; do not edit it. When another session saved the app after your checkout, `save_app` refuses your save and says so: check the app out into a new folder, make your change there, and save that folder. Never copy your old files over the new checkout without a look at what changed.

## After the deploy

- Each operation is a tool named `<slug>__<operation>` from the next turn of any session on the host. Tell the user that their agents can now use the app, and name one thing to ask for. The user can turn that off on the Manage page.
- `list_apps` says what the host has: each app's slug, its active version, its operations, and what needs the user.
- When the receipt says a secret is not set, tell the user to set it on the app's Manage page, under Secrets.
- When the receipt says the version failed, the version before it still runs. The receipt has the end of the build log, or the error of the migration or the start. Fix the cause, save, and deploy again.
- Tell the user where the app's Manage page is (the Manage switch above the app): its calls, its runs, its files, its signals, and its versions are there.

## Repair an app

`inspect_app` reads what the host kept, so do not guess:

- `view: "overview"`: the state, the instructions, what needs the user, and the calls of the last 24 hours with their times.
- `view: "calls"` with `outcome: "failed"`, then `view: "call"` with the `id`: the call's input, its log lines, its trace (each request, each integration tool, the SQL, each step), and the stack of its error.
- `view: "runs"` and `view: "run"`: the workflow runs and the state, the attempts, and the error of each step.
- `view: "signals"`: the signals, their actions, and how each action ended.
- `view: "build"`: the build log of a version.

Then `checkout_app`, fix the cause, `preview_app`, `save_app`, `deploy_app`, and read the call log again.

## An app from an older template

An app that was built with an older template keeps working: Solus runs each build with the `ctx` of its own protocol. To use app files, workflows, signals, or output schemas in such an app, make a new project with this skill's initializer in a scratch folder and copy its `src/solus-app-backend.ts` and `src/solus-app.ts` over the ones in the checkout. Then change `ctx.files` (the path of a folder before) to `ctx.files.dir`.
