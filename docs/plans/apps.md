# Apps: what a person builds to live in Solus

Status: the first release (UI over integrations) shipped 2026-11-11. The
general model below was decided 2026-11-11 and replaces it (§11 says what
changed). Sharing and deployment are next and not started (§10).

The first release took the artifact model of Executor 2
(`UsefulSoftwareCo/executor`, `packages/hosts/mcp-apps-shell` and
`packages/hosts/mcp/src/artifact-bindings.ts`) and mapped it onto what Solus
already has: the integration gateway (`docs/plans/mcp-integrations.md`), the MCP
App frame host (`docs/plans/conversation-card-parity.md` §MCP Apps), and works.

## 0. The idea

A person asks for an app and gets one that lives in Solus: it is a work, it
opens on desktop, web, and mobile, and it keeps its own data. The agent can
build whatever the person wants. An app has four things to build with, and
each is optional:

- **`storage`** — the app's own data, kept by the host.
- **`fetch`** — the network, to the hosts the app names.
- **`server`** — the app's own functions, which run on the host. This is how an
  app opens a database, reads a file, or uses a package that needs Node.
- **`tools`** — the person's connected integrations. This is the easy way to
  the data a person already has. It is not what makes something an app.

The frame stays closed. Everything an app does outside its own page leaves the
frame as data and is checked by the server: an integration call against the
app's permissions, a host function and a network host against the host access
the host's owner allowed.

## 1. Vocabulary

- **app** — a work of type `app`. Its content is a component or a bundle.
- **component** — one TSX module that default-exports a React component and
  imports only what the shell provides (§4). The quick form: the server
  compiles it.
- **bundle** — the built form of an app project: one JSON document with the
  client code, its CSS, the server code if the app has host functions, the
  integrations it names, and its sources (§3).
- **app project** — the folder the `apps` skill makes and builds. It is the
  build input. Solus keeps the bundle, not the folder.
- **shell** — the prebuilt frame page: React, TanStack Query, Recharts, Lucide,
  the Tailwind browser runtime, a small set of Solus UI primitives, and the
  `tools`, `storage`, and `server` objects. Built once, shipped with Solus.
- **storage** — the app's own key-value data on the host. It belongs to the
  app, not to a viewer.
- **host function** — an export of a bundle's server module. The frame calls it
  as `server.<name>(input)`. It runs on the host, in the app's runner.
- **runner** — the child process that runs one app's host functions under the
  app's host access.
- **role** — an integration the app names: the slug in `tools.<slug>.<tool>`.
  Never a connection.
- **binding** — the resolution of a role to the viewer's own integration with
  that slug, made on every call. Nothing about a connection is stored.
- **permissions** — the app's own settings: which integration tools it may
  call, whether a write asks first, the network hosts it may reach, and the
  host paths its host functions may read and write (§5).
- **host access** — what an app asks for outside integrations and storage: to
  run host functions, to reach network hosts, to read and write host paths.
  The host's owner allows it once and can revoke it (§6).
- **call name** — what the frame puts on the wire: `<slug>/<tool>` for an
  integration tool, `@storage/<operation>`, or `@server/<function>`.
- **create_app** — the agent tool that makes or updates an app.
- **apps skill** — the bundled skill that owns the app project workflow.

Do not call an app an artifact, a widget, a plugin, or a dashboard. Do not
call a host function a tool, an action, or an endpoint.

## 2. Decisions

1. **A work type, `app`.** It has history, comments, the works list, the
   session's artifacts, cloud copy, and `read_work` for free.
2. **The frame host is the existing MCP App host.** `createMcpAppHost` and its
   protocol are reused unchanged. Storage and host functions ride the same
   `tools/call` message under reserved call names, so the desktop frame, the
   web frame, and the mobile web view need no new channel.
3. **The shell is a production build.** `packages/app-shell/` is built by
   `scripts/build-app-shell.ts` into `resources/app-shell/shell.js`. The server
   inlines it into each app's document, so a frame needs no network to start.
4. **Two content forms, one runtime.** A component is compiled on the server
   with `sucrase`. A bundle is compiled by the agent with the skill's build.
   Both become the same thing in the document: a CommonJS module body the
   shell runs with its own `require`. The content says which form it is: a
   bundle is a JSON object with `"solusApp": 1`; anything else is a component.
5. **Any package, through a build the agent runs.** Solus does not install
   packages or run a bundler for an app. The skill's project does, on the
   host where the agent works, as the visual artifacts skill does. The build
   leaves React, TanStack Query, Recharts, Lucide, and `@solus/app` to the
   shell, so an app and the shell share one React.
6. **Host functions run in a child process under declared host access.** One
   runner for each app, started on the first call, stopped when idle. It runs
   under Node's permission model with the app's file paths; it has no child
   processes, no workers, and no native add-ons. §6 says what is enforced by
   the runtime and what is a check in the runner.
7. **Host access is the owner's decision, made once.** An agent declares what
   an app needs. Nothing of it is in force until the host's owner allows it in
   the app's header. A wider request asks again; a narrower one does not. The
   owner can revoke it.
8. **Host functions run only for the host's owner in this release.** Code an
   agent wrote runs with the owner's files and network, so only the owner
   starts it. Another person who can open the work sees the app, its storage,
   and its integrations, and a clear message where a host function would run.
9. **Roles bind to the viewer, never to the author.** The server resolves
   `<slug>` to the caller's own integration with that slug on every call.
10. **One account per role.** An integration with several connected accounts
    runs the app's calls on its first connected account.
11. **Integration permissions are under the gateway's.** An app can narrow what
    the viewer's integrations allow. It can never widen it.
12. **Storage belongs to the app.** Everyone who can use the app on a host
    reads and writes the same data. A viewer's own data is a later decision
    that sharing makes (§10).
13. **An app that needs a value asks for it.** A database browser asks for the
    database URL in its own page and keeps it in storage. Solus has no
    built-in database integration and no declared app inputs. A value that
    must stay out of the frame (a secret kept in the vault) is a later step.
14. **Roles are not stored for a component.** They are read from the source on
    every read and call. A bundle lists them, because its build read them from
    the sources.
15. **No server-side smoke render.** Solus refuses code that does not compile
    and reports a first-render error from the frame's error boundary.
16. **Not taken:** Executor's custom tool apps, QuickJS, workerd, and deploy
    tokens; a framework other than React in the frame; a bundler inside the
    Solus server.

## 3. Data

`Work.content` of an `app` is a component (TSX text) or a bundle:

```ts
interface AppBundle {
  solusApp: 1
  client: string                 // CommonJS module body; its default export is the component
  css?: string                   // styles the client imported
  server?: string                // CommonJS module for Node; each exported function is a host function
  integrations: string[]         // the roles, read from the sources by the build
  sources?: { [path: string]: string }   // the project's own files, so a later session can read and rebuild them
}
```

A bundle is at most 8 MiB, the limit of a work's file. Work meta carries the
app's settings on the `meta` JSON column, so no migration:

```ts
interface AppMeta {
  permissions: AppPermissions
  /** The host access the host's owner allowed. Absent: none allowed. */
  allowed?: AppHostAccess
}
interface AppPermissions {
  tools: 'all' | 'read-only' | { selected: string[] }   // selected: "<slug>/<tool>"
  writes: 'ask' | 'allow'
  network: string[]                                     // "api.example.com", "*.example.com", "db.internal:5432", "*"
  files: { read: string[]; write: string[] }            // absolute or "~/" host paths; "*" is every path
}
interface AppHostAccess {
  functions: boolean
  network: string[]
  files: { read: string[]; write: string[] }
}
```

Default permissions: `{ tools: 'all', writes: 'ask', network: [], files: {
read: [], write: [] } }`. Meta written by the first release has no `network`
or `files` and reads as the default.

App data is on the host, outside the works table, under
`<data dir>/app-data/<work id>/`: `storage.json` is the app's storage; `data/`
is a folder its host functions may always read and write. Deleting the work
removes the folder.

## 4. The shell

`packages/app-shell/src/`:

- `shell.tsx` — mounts the component under a `QueryClientProvider`, an error
  boundary, and the Solus theme; connects to the host over the MCP Apps
  protocol.
- `host-bridge.ts` — the frame's side of that protocol. Every message is
  parsed at this boundary.
- `tools-proxy.ts` — the `tools` object: `tools.<slug>.<tool>(args)` with the
  TanStack Query helpers, keyed by path.
- `app-data.ts` — `storage` (`get`, `set`, `delete`, `keys`) and `server`
  (`server.<name>(input)`), each one `tools/call` under a reserved call name.
- `modules.ts` — what `require` answers: `react`, `react/jsx-runtime`,
  `react-dom`, `@tanstack/react-query`, `recharts`, `lucide-react`, and
  `@solus/app` (`tools`, `storage`, `server`, `useApp()`, and the UI
  primitives). A bundle carries every other package inside itself.
- `ui/` — Button, Card, Input, Select, Badge, Table, Tabs, Skeleton, Empty,
  Stat, styled with the Solus variables.

The document the server composes (`apps/app-shell.ts`):

```html
<style>/* both Solus palettes; the shell switches with data-theme */</style>
<style>/* the bundle's css, if any */</style>
<div id="solus-app-root"></div>
<script>/* shell.js */</script>
<script>SolusAppShell.define(function (require, module, exports) { /* the client */ })</script>
<script>SolusAppShell.mount({ roles, permissions, hostAccess })</script>
```

Nothing is evaluated from a string: the MCP App policy (`mcpAppDocument`) has
no `unsafe-eval`. Its `connect-src` is `'none'` until the owner allows the
app's network hosts; then it lists them as HTTPS and WSS origins, and the
app's own `fetch` reaches them. The browser's CORS rules still apply; a
service without CORS is called from a host function.

## 5. Permissions

Set by `create_app`, shown in the app's header. The person changes tools and
writes there; network and files change through `create_app` and take effect
when the owner allows them (§6).

| Setting | Values | Default |
|---|---|---|
| Tools | `all`, `read-only`, `selected` (a list of `<slug>/<tool>`) | `all` |
| Writes | `ask` (approval on each write), `allow` | `ask` |
| Network | a list of hosts; `*` is every host | none |
| Files | paths to read, paths to write; `*` is every path | none |

`toolInfo(name)` answers from the current state, on every call:

- An integration tool is callable when the slug is one of the app's roles, the
  caller owns an integration with that slug, the tool exists there and is not
  turned off, and the permissions admit it. It is read-only when the tool has
  `readOnlyHint` or writes are `allow`; else the frame host asks first.
- `@storage/<operation>` is always callable and never asks.
- `@server/<function>` is callable when the bundle has a server module, the
  owner allowed the app's host access, and the caller is the host's owner. It
  never asks on a call: the owner allowed the host access as a whole.

## 6. Host access

What the app asks for comes from two places: `functions` is true when the
bundle has a server module; `network` and `files` are its permissions. An app
that asks for nothing (a component, or a bundle with no server module and no
network hosts) needs no decision.

- **Pending.** The app asks for more than `allowed` covers. The header says
  what it asks for, with **Allow**. Until then the frame has no network and a
  host function call fails with a message that says so.
- **Allowed.** `allowed` covers the request. The header says what is in force,
  with **Revoke**.
- Only the host's owner sees the buttons. Allow writes the current request
  into `allowed`; Revoke removes it and stops the runner.

The runner (`apps/app-functions.ts`, `apps/app-runner-script.ts`):

- One process for each app, started on the first call with the host's own
  Node (`process.execPath`, as the member file process does), stopped after
  five idle minutes, on a new revision, on a change of host access, on revoke,
  and when the work is deleted. A call has 60 seconds.
- It starts with `--permission`, `--allow-fs-read` and `--allow-fs-write` for
  the app's paths and its `data/` folder, a small environment (no token of the
  server's), and a memory limit. It refuses to load the app when the
  permission model is not on.
- The server module arrives on stdin and is run with a `require` for Node's
  own modules. Each export that is a function is a host function:
  `async (input, context) => value`, where `input` is the one JSON object the
  frame sent and `context.dataDir` is the app's `data/` folder. The value
  goes back as JSON, at most 1 MiB.

What enforces what, in plain words:

- **Files** — Node's permission model, for the file system module. The runner
  also checks the path when `node:sqlite` opens a database, because that
  module does not ask the permission model. SQL that opens another file
  (`ATTACH`, `VACUUM INTO`) is not checked.
- **Network** — the runner checks the host of every socket against the app's
  list. On a Node that has the network permission (25 and later), no network
  host means the runtime itself refuses every socket. The desktop app and the
  packaged server run Node 24, where the check in the runner is the only one.
- **Processes** — the permission model refuses child processes, workers, and
  native add-ons.

So host access keeps an app the owner allowed inside what the owner read. It
is not a jail for hostile code, and that is why only the owner runs it and why
sharing an app with host functions waits (§10).

## 7. Server

`packages/server/src/apps/`:

- `app-content.ts` — reads a work's content as a component or a bundle; the
  one place that knows both forms. `appContentProblem` is the check every
  write of an `app` work passes.
- `app-source.ts` — role extraction and the sucrase compile of a component.
- `app-permissions.ts` — `admits` for an integration tool; the host access an
  app asks for, and whether an allowed one covers it.
- `app-shell.ts` — reads the built shell once, composes the document.
- `app-storage.ts` — the app's key-value file, with size limits and one
  writer at a time for each app.
- `app-functions.ts` and `app-runner-script.ts` — the runner (§6).
- `apps.ts` — `Apps`: `read`, `toolInfo`, `callTool` (which sends a call name
  to the gateway, storage, or the runner), `permissionsUpdate`,
  `hostAccessDecide`, and `forget` for a deleted work.
- `transport/handlers/app-handlers.ts` — `appRead`, `appToolInfo`,
  `appCallTool`, `appPermissionsUpdate`, `appHostAccessDecide`.
- `execution/agents/tools/app-tools.ts` — `create_app`: `title`, one of `code`
  (a component) or `bundle_path` (the bundle file the skill's build wrote),
  `permissions?`, `work_id?` with `expected_content_version`. The receipt
  says what host access the app still waits for.

`read_work` of a bundle answers its sources, not its compiled code.

## 8. The apps skill

`resources/plugins/solus/skills/apps/`, given to Claude Code and Codex like
every bundled skill. A skill's description is in every prompt, so it is also
how an agent finds `create_app`, which loads behind tool search.

- `scripts/init-app.mjs <new directory>` — makes the project: React and
  TypeScript sources, the types of `@solus/app`, pinned dependencies, and the
  build script.
- `npm run bundle` — typechecks, bundles `src/App.tsx` for the frame and
  `server.ts` (when present) for Node with esbuild, reads the roles from the
  sources, and writes `app.bundle.json`.
- `create_app` with `bundle_path` saves it. A revision is the same build and
  `create_app` with `work_id`.

The runtime instructions name the skill for a run that has `create_app`, and
the `building-for-web` skill says it is for a codebase to deploy, not for an
app that lives in Solus.

## 9. Clients, entry points, and states

- **Desktop and web.** `WorkPane` opens `app` works in `AppShell.svelte`: the
  works header, the two permission selects, the connect notice, the host
  access bar, and the frame (`McpAppFrame.svelte` given app calls).
- **Mobile.** The thread feed shows an app row for `work_created`,
  `work_updated`, and a `create_app` receipt in history, with the permissions
  as one line and the host access bar.
- In: `create_app`. Out: delete the work, which removes its data. Update:
  `create_app` with `work_id`.
- Reverse states: `read-only` is the way back from `all`; Revoke is the way
  back from Allow.
- States, each a message in the pane, the frame, or the tool result: shell
  missing, compile error, bundle not valid, role not connected, tool turned
  off, write declined, result too large, host access pending, caller not the
  owner, host function missing, host function failed or timed out, storage
  full.

## 10. Next: sharing and deployment

Not started. The call path stays the same; the host becomes the Solus API.

- **Share** is the existing cloud copy of a work. The link opens the same
  shell on the Solus API and roles resolve to the signed-in viewer's own
  cloud connections (`docs/plans/cloud-vault.md`). Storage moves with the
  work, and that is where each-viewer storage is decided.
- **Deploy** is a standalone web app at its own URL. Build `/mcp` on the Solus
  API (and the host) as the one door for every client that is not Solus, and
  make the deployed app its first consumer: the shell's bridge gets a second
  transport, HTTP in place of `postMessage`. Take T3 Code's credential and
  grant design for it (`McpSessionRegistry`, `McpToolAccess`, `McpOAuth`).
- **Host functions for other people** need a runtime that is a real boundary
  (a container or an isolate for each app), because the code then runs for
  someone who did not read it. Until that exists, an app with host functions
  is not shared and not deployed.
- Access is a deployment setting: organization members sign in and use their
  own connections; a public deployment runs on the owner's connections
  through explicit per-connection grants with a visible banner.

## 11. What shipped

**2026-11-11, first release.** `packages/app-shell/`, `packages/contracts/src/apps.ts`,
`packages/server/src/apps/`, `create_app` with `code`, the desktop, web, and
mobile surfaces, and `tests/unit/apps.test.ts`. An app was UI over
integration tools and nothing else.

**The general model** changes these decisions of the first release: the
content may be a bundle (was: the component source only); an app has storage,
network, and host functions (was: "nothing of it runs on the server but the
compile and the call check"); and `mcp-integrations.md` no longer puts
authored apps out of scope.

Not in this release: the `selected` tools list, the network hosts, and the
file paths have no editor in the header (an agent sets them through
`create_app`); a work in an organization's Solus API keeps the default
permissions and has no host access; the mobile works list has no app screen,
as it has none for any work.
