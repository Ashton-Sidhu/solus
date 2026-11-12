# Apps: what a person builds to live in Solus

Status: decided 2026-11-11, third model; the app's window decided 2026-11-12.
An app is a full application. It is built by the `visual-artifacts` skill, it
is saved as an artifact, it runs in the artifact frame as a window with its
own pages, and it adds four things an artifact does not have (§0). Sharing and deployment are next
and not started (§9). §10 says what the two earlier models were and why they
were replaced.

## 0. The idea

A person asks for an app and gets one that lives in Solus: it is a work, it
opens in its own window on desktop, web, and mobile, and it keeps its own
data. It is a full application: it has as many pages as it needs, its own
navigation, and its own layout. The agent builds it as it builds any visual
artifact: a React and TypeScript project with Tailwind, any npm package, its
own styles, the skill's design guidelines, and a preview it can look at
before the person does.

An app is an artifact whose page carries an **app manifest**. The manifest
turns on four things, and each is optional:

- **`storage`** — the app's own data, kept by the host.
- **`fetch`** — the network, to the hosts the app names.
- **`server`** — the app's own functions, which run on the host. This is how an
  app opens a database, reads a file, or uses a package that needs Node.
- **`tools`** — the person's connected integrations. This is the easy way to
  the data a person already has. It is not what makes something an app.

Everything an app does outside its own page leaves the frame as data and is
checked by the server: an integration call against the app's permissions, a
host function and a network host against the host access the host's owner
allowed.

## 1. Vocabulary

- **app** — an `artifact` work whose page has an app manifest.
- **app manifest** — one JSON block in the page (§3): the app's permissions,
  the integrations it names, its server module, and its sources. The build
  writes it. A page without one is a plain artifact.
- **app project** — a `visual-artifacts` project with an `app.json`. It is the
  build input. Solus keeps the built page, not the folder.
- **storage** — the app's own key-value data on the host. It belongs to the
  app, not to a viewer.
- **host function** — an export of the project's `server.ts`. The page calls it
  as `server.<name>(input)`. It runs on the host, in the app's runner.
- **runner** — the child process that runs one app's host functions under the
  app's host access.
- **role** — an integration the app names: the slug in `tools.<slug>.<tool>`.
  Never a connection.
- **binding** — the resolution of a role to the viewer's own integration with
  that slug, made on every call. Nothing about a connection is stored.
- **permissions** — what the app declares in `app.json`: which integration
  tools it may call, whether a write asks first, the network hosts it may
  reach, and the host paths its host functions may read and write (§5).
- **host access** — what an app asks for outside integrations and storage: to
  run host functions, to reach network hosts, to read and write host paths,
  and to write through integrations without asking. The host's owner allows it
  and can revoke it (§6).
- **call name** — what the page puts on the wire: `<slug>/<tool>` for an
  integration tool, `@storage/<operation>`, or `@server/<function>`.
- **app frame** — the artifact frame of a page that has a manifest: a window of
  a fixed size the page scrolls inside, no network but the allowed hosts, and
  a bridge for calls (§4).
- **page** — one screen of an app: a route in the address after `#`. All the
  pages of an app are in its one built file.
- **create_app** — the agent tool that saves or updates an app.

Do not call an app a widget, a plugin, or a dashboard. Do not call a host
function a tool, an action, or an endpoint.

## 2. Decisions

1. **An app is saved as an artifact.** Its content is one built HTML file. It
   has everything an artifact work has with no second implementation: the
   pane, history with change marks, comments, embeds in a document or plan,
   the session's artifacts, the mobile row, the cloud copy, `read_work` and
   `update_work`. There is no `app` work type.
2. **One authoring path: the `visual-artifacts` skill.** The same project,
   the same build, the same design guidelines, the same preview. An app takes
   the skill's guidelines, not the frame rules of a visual in a reply: those
   are for a document, and an app is an application (decision 15). An `app.json` in
   the project makes it an app: the build then writes the manifest into
   `bundle.html`, and bundles `server.ts` into it when there is one. There is
   no second skill, no prebuilt shell, and no component kit.
3. **The page is the whole app.** The manifest is in the page, so one file
   holds the app at every revision: a restore, a copy, and a cloud copy carry
   the page, its permissions, and its host code together.
4. **The frame decides from the page it runs.** A client gives a page the app
   frame, and relays its calls, only when that page has a manifest. The
   policy and the relay come from the same text, so a page cannot have calls
   and an open network at once.
5. **An app frame has no network but the allowed hosts.** A plain artifact may
   load HTTPS resources; an app may read a person's integrations, so it may
   not. The build already puts every dependency, style, and asset in the page.
6. **`create_app` is the artifact tools with an app check.** It saves through
   `render_artifact`'s own path and updates through `update_work`'s, refuses a
   page that has no manifest, and says in its receipt what host access the app
   waits for. Its preview is `render_artifact`'s preview with a host that
   answers the page's calls.
7. **Host functions run in a child process under declared host access.** One
   runner for each app, started on the first call, stopped when idle, under
   Node's permission model with the app's file paths; no child processes, no
   workers, no native add-ons. §6 says what enforces what.
8. **Host access is the owner's decision, made for the host code as it is.**
   Nothing of it is in force until the host's owner allows it. A wider request
   asks again; a narrower one does not. Changed host code asks again, whoever
   changed it: the decision names the server module by its hash. A change of
   the page alone does not ask again. The owner can revoke the decision, and a
   copy of an app starts without one.
9. **Host functions run only for the host's owner in this release.**
10. **Roles bind to the viewer, never to the author.** One account for each
    role: an integration with several accounts uses its first connected one.
11. **Integration permissions are under the gateway's.** An app can narrow what
    the viewer's integrations allow. It can never widen it. A write asks the
    person each time, unless the app declares `writes: "allow"` and the owner
    allowed that as part of its host access.
12. **Storage belongs to the app.** Everyone who can use the app on a host
    reads and writes the same data.
13. **An app that needs a value asks for it.** A database browser asks for the
    database URL in its own page and keeps it in storage. Solus has no
    built-in database integration and no declared app inputs.
14. **Not taken:** Executor's custom tool apps, QuickJS, workerd, and deploy
    tokens; a bundler inside the Solus server.
15. **An app is a window, not a document.** A visual in a reply is as tall as
    its content and has no shell. An app's frame is a window of a fixed size:
    all of the pane it opens in, a fixed height in a conversation, a document,
    or a history view, and the full screen on a phone. The page lays itself
    out in that window and scrolls inside it, in standards mode, so it can
    have a sidebar, a header that stays in place, and its own scroll regions.
16. **An app has pages, in one file.** A page is a route in the address after
    `#`. A link that starts with `#` stays in the frame; any other link opens
    outside it. Nothing of this is in the manifest or on the server: the app
    routes itself. A preview opens one page by its route.

## 3. Data

An app's content is its page. The manifest is one script block in it:

```html
<script type="application/json" id="solus-app">{"solusApp":1,"permissions":{…},"integrations":["linear"],"server":"…","sources":{"src/App.tsx":"…"}}</script>
```

```ts
interface AppManifest {
  solusApp: 1
  permissions: AppPermissions
  integrations: string[]                  // the roles, read from the sources by the build
  server?: string                         // CommonJS module for Node; each exported function is a host function
  sources?: { [path: string]: string }    // the project's own files, so a later session can read and rebuild them
}
interface AppPermissions {
  tools: 'all' | 'read-only' | { selected: string[] }   // selected: "<slug>/<tool>"
  writes: 'ask' | 'allow'
  network: string[]                                     // "api.example.com", "*.example.com", "db.internal:5432", "*"
  files: { read: string[]; write: string[] }            // absolute or "~/" host paths; "*" is every path
}
```

Every `<` in the block is written `<`, so nothing in it can end the
script element. `readAppPage` in `@solus/contracts/apps` is the one reader,
for the server and for every client. A block that is there and is not a valid
manifest is refused when the work is saved.

Work meta carries only the owner's decision, on the `meta` JSON column:

```ts
interface AppMeta {
  /** What the host's owner allowed, and the host code it was allowed for. Absent: nothing allowed. */
  allowed?: { access: AppHostAccess; serverHash: string | null }
}
interface AppHostAccess {
  functions: boolean
  /** Integration writes run without asking. */
  writes: boolean
  network: string[]
  files: { read: string[]; write: string[] }
}
```

App data is on the host, outside the works table, under
`<data dir>/app-data/<work id>/`: `storage.json` is the app's storage; `data/`
is a folder its host functions may always read and write. Deleting the work
removes the folder.

## 4. The app frame

`wrapSandboxDocument` in `@solus/contracts/artifact-sandbox` builds every
artifact frame's document. For a page with a manifest it takes the app's
allowed network hosts and:

- starts the document with a doctype, so the page is laid out in standards
  mode, and adds the window stylesheet: the page scrolls and is at least as
  tall as the window;
- writes the app policy: no network but those hosts (as HTTPS and WSS origins
  for `connect-src`, and for images and media), inline scripts and styles,
  `data:` fonts;
- adds the bridge: `window.solusApp.call(name, args)`, which posts
  `{ type: "solus-app-call", id, name, args }` to the host and settles on
  `{ type: "solus-app-result", id, ok, value | error }`.

The project's `@solus/app` module is a typed face over that one function:
`storage`, `server`, and `tools`. It holds no protocol, so the host can change
the transport without a rebuild of any app.

A frame host gives an app its window and ignores the height the page
reports: `SandboxFrame.svelte` on desktop and web, `ThreadArtifact.tsx` on a
phone. The artifact pane gives an app all of its body, with no padding.

The host side of a call is `answerAppCall` in `@solus/client-core/app-calls`, shared by
desktop, web, and mobile: it asks `appToolInfo`, asks the person before a
call that is not read-only, runs `appCallTool`, and gives the page the value.
A frame that has no work to call for (a fenced page in a reply, an embed, a
history view) answers every call with an error, so a page never waits.

## 5. Permissions

Declared in the project's `app.json`, written into the manifest by the build.

| Setting | Values | Default |
|---|---|---|
| `tools` | `all`, `read-only`, `selected` (a list of `<slug>/<tool>`) | `all` |
| `writes` | `ask` (the person approves each write), `allow` | `ask` |
| `network` | a list of hosts; `*` is every host | none |
| `files` | paths to read, paths to write; `*` is every path | none |

`appToolInfo(name)` answers from the current state, on every call:

- An integration tool is callable when the slug is one of the app's roles, the
  caller owns an integration with that slug, the tool exists there and is not
  turned off, and the permissions admit it. It is read-only when the tool has
  `readOnlyHint`, or when `writes` is `allow` and the owner allowed that.
- `@storage/<operation>` is always callable and never asks.
- `@server/<function>` is callable when the manifest has a server module, the
  owner allowed the app's host access, and the caller is the host's owner.

## 6. Host access

What the app asks for: `functions` when the manifest has a server module,
`writes` when its permissions say `allow`, and its `network` and `files`. An
app that asks for nothing needs no decision.

- **Pending.** The app asks for more than `allowed` covers, or its host code
  is not the code `allowed` names. The artifact's header says what it asks
  for, with **Allow**. Until then the frame has no network, a host function
  call fails with a message that says so, and a write asks.
- **Allowed.** The header says what is in force, with **Revoke**.
- Only the host's owner sees the buttons. `create_app` tells the agent when an
  app waits, so the agent tells the person.

The runner (`apps/app-functions.ts`, `apps/app-runner-script.ts`):

- One process for each app, started on the first call with the host's own
  Node, stopped after five idle minutes, on a new revision, on a change of
  host access, on revoke, and when the work is deleted. A call has 60 seconds.
- It starts with `--permission`, `--allow-fs-read` and `--allow-fs-write` for
  the app's paths and its `data/` folder, a small environment (no token of the
  server's), and a memory limit. It refuses to load the app when the
  permission model is not on.
- Each export of the server module that is a function is a host function:
  `async (input, context) => value`, where `input` is the one JSON object the
  page sent and `context.dataDir` is the app's `data/` folder. The value goes
  back as JSON, at most 1 MiB.

What enforces what, in plain words:

- **Files** — Node's permission model, for the file system module. The runner
  also checks the path when `node:sqlite` opens a database. SQL that opens
  another file (`ATTACH`, `VACUUM INTO`) is not checked.
- **Network of host functions** — the runner checks the host of every socket.
  On a Node with the network permission (25 and later), no network host means
  the runtime itself refuses every socket. The desktop app and the packaged
  server run Node 24, where the check in the runner is the only one.
- **Network of the page** — the frame's policy. A frame can still navigate
  itself away, which no policy closes; the artifact frame has the same limit.
- **Processes** — the permission model refuses child processes, workers, and
  native add-ons.

Host access keeps an app the owner allowed inside what the owner read. It is
not a jail for hostile code, and that is why only the owner runs host
functions and why sharing an app with host functions waits (§9). One limit is
the owner's to know: the decision for network hosts does not name the page's
code. A person with edit rights on an app can change what its page sends to
the hosts the owner allowed.

## 7. Server

`packages/server/src/apps/`:

- `app-content.ts` — a work's page as an app (`readAppPage`, kept for the
  revision it was read from), the hash of its host code, and what `read_work`
  answers for an app: its sources, not megabytes of built page.
- `app-permissions.ts` — `admits` for an integration tool; the host access an
  app asks for; `hostAccessState`.
- `app-storage.ts` — the app's key-value file.
- `app-functions.ts` and `app-runner-script.ts` — the runner (§6).
- `apps.ts` — `Apps`: `read` (the app's roles, permissions, and host access),
  `toolInfo`, `callTool`, `hostAccessDecide`, and `forget` for a deleted work.
- `transport/handlers/app-handlers.ts` — `appRead`, `appToolInfo`,
  `appCallTool`, `appHostAccessDecide`.
- `execution/agents/tools/app-tools.ts` — `create_app`: `title`, `html_path`,
  the preview inputs of `render_artifact`, `preview_route` for one page, and
  `work_id` for a preview of a saved app.
- `data/works/artifact-preview.ts` — the preview takes an optional app host:
  it opens the page the route names in a window 800px tall, drains the
  page's calls, answers them, and then takes a picture of the window.

A preview answers storage from memory, runs a host function only when the
owner already allowed this code for this work, and never writes through an
integration.

## 8. The skill

`resources/plugins/solus/skills/visual-artifacts/`. Its `references/apps.md`
is the app chapter; the main file points to it. In the project template:

- `src/solus-app.ts` — `@solus/app`: `storage`, `server`, `tools`.
- `app.json` (the agent adds it) — `{ "permissions": { … } }`.
- `server.ts` (the agent adds it) — the host functions.
- `npm run bundle` — as for any artifact; with an `app.json` it also bundles
  `server.ts` for Node, reads the roles from the sources, and writes the
  manifest into `bundle.html`.

The runtime instructions name the skill and `create_app` for a run that has
the tool, and say that a web project is scaffolded only for a codebase to
deploy. The `building-for-web` skill says the same of itself.

## 9. Next: sharing and deployment

Not started. The call path stays the same; the host becomes the Solus API.

- **Share** is the existing cloud copy of a work. Roles resolve to the
  signed-in viewer's own cloud connections (`docs/plans/cloud-vault.md`).
  Storage moves with the work, and that is where each-viewer storage is
  decided.
- **Deploy** is a standalone web app at its own URL, through `/mcp` on the
  Solus API, with T3 Code's credential and grant design.
- **Host functions for other people** need a runtime that is a real boundary
  (a container or an isolate for each app). Until that exists, an app with
  host functions is not shared and not deployed.

## 10. The two earlier models

**First release, 2026-11-11.** A work type `app` whose content was one TSX
component, compiled on the server and run in a prebuilt shell
(`packages/app-shell/`) inside the MCP App frame. An app was UI over
integration tools and nothing else.

**Second model, same day, never merged.** The component or a bundle from a
separate `apps` skill, with storage, network, and host functions, still in
the shell and the MCP App frame.

Both were replaced for one reason: they were a second implementation of what
artifacts already had. The shell's component kit looked worse than what the
`visual-artifacts` pipeline produces, an agent had no preview of an app, and
every artifact surface needed an `app` branch beside it. What stays from them
is everything that was new: the manifest's permissions, host access, storage,
the runner, and the viewer binding.

Not in this release: the permissions have no editor in the header (they are
in `app.json`); a work in an organization's Solus API has no host access; a
work that Share moves to an organization leaves its app data on the host it
left; the works list does not mark an app apart from any artifact.
