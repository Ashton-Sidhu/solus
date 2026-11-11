# Apps: agent-built UI over a person's own integrations

Status: decided 2026-11-03; the first release is implemented, 2026-11-11 (§10).
Sharing and deployment are next and not started (§9). This plan takes the
artifact model of Executor 2 (`UsefulSoftwareCo/executor`,
`packages/hosts/mcp-apps-shell` and
`packages/hosts/mcp/src/artifact-bindings.ts`) and maps it onto what Solus
already has: the integration gateway (`docs/plans/mcp-integrations.md`), the MCP
App frame host (`docs/plans/conversation-card-parity.md` §MCP Apps), and works.

## 0. The idea

An agent writes one React component. Solus runs it in the MCP App frame it
already has, with a prebuilt shell around it. The component reaches a service
through `tools.<integration>.<tool>(...)`. Every call leaves the frame as data,
is checked by the server against the app's permissions, and runs through the
gateway with the viewer's own connection. The credential never reaches the
frame, the agent, or the app.

An app authored in Solus is an MCP App whose server is Solus itself.

## 1. Vocabulary

- **app** — a work of type `app`. Its content is the component source (TSX).
  Its meta carries its permissions.
- **shell** — the prebuilt frame page: React, TanStack Query, Recharts, Lucide,
  the Tailwind browser runtime, a small set of Solus UI primitives, and the
  `tools` proxy. Built once, shipped with Solus, never compiled per app.
- **component** — the TSX the agent writes. It default-exports a React
  component and imports only from the modules the shell provides (§4).
- **role** — an integration the component names: the slug in
  `tools.<slug>.<tool>`. Read from the source; never a connection.
- **binding** — the resolution of a role to the viewer's own integration with
  that slug, made on every call. Nothing about a connection is stored.
- **permissions** — the app's own ceiling, set at create time and editable:
  which tools it may call and whether a write asks first (§5).
- **tool name** — what the frame puts on the wire: `<slug>/<tool>`.
- **create_app** — the agent tool that makes or updates an app.

Do not call an app an artifact, a widget, a plugin, or a dashboard.

## 2. Decisions

1. **A new work type, `app`.** It has history, comments, the works list, the
   session's artifacts, cloud copy, and `read_work`/`update_work` for free. The
   source is the content, so a diff of two revisions is a diff of the
   component. `workExportExtension('app')` is `tsx`.
2. **The frame host is the existing MCP App host.** `createMcpAppHost` and its
   protocol are reused unchanged: `tools/call` carries `{ name, arguments }`,
   the host asks `toolInfo(name)` then `callTool(...)`, writes wait for the
   person's approval, the size and display-mode notifications work as they do.
   `McpAppFrame.svelte` and the mobile web view take the three host calls as
   an object instead of a session activity, so an app and a captured MCP App
   share one frame.
3. **The shell is a production build.** `packages/app-shell/` is a workspace
   package built by `scripts/build-app-shell.ts` with esbuild into
   `resources/app-shell/shell.js`, minified, gitignored. The dev script builds
   it once at start like the web client; the app build and the packaged server
   run and copy it next to `resources/plugins`. The server reads it from
   `bundledResourcesDir()` and inlines it into each app's document, so a frame
   on any client, including the native web view, needs no network. A missing
   build is a clear error in the pane, not a blank frame.
4. **The component is compiled on the server.** `sucrase` (pure JavaScript, no
   native binary) strips types and JSX and turns imports into `require` calls
   that the shell answers. Every write of an `app` work compiles first
   (`validateWorkContent`), so a syntax error reaches the agent as the tool
   result. The document is composed on every read; the compile is memoized by
   content hash.
5. **Roles bind to the viewer, never to the author.** The server resolves
   `<slug>` to the caller's own integration record with that slug
   (`IntegrationStore.getBySlug` under the caller's owner key) on every call.
   A viewer with no such integration sees a connect notice; the roles and
   their connected state come with the snapshot so the notice shows before the
   first call fails. This is the integrations plan's rule, applied to apps, and
   it is why sharing needs no rebinding later.
6. **One account per role in the first release.** Executor's
   `tools.linear("prod")` form is not taken. An integration with several
   connected accounts (`mcp-integrations.md` §13.3) runs the app's calls on
   its first connected account.
7. **Permissions are the app's own setting, under the gateway's.** The app can
   narrow what the viewer's integrations allow. It can never widen it: a tool
   the owner turned off stays off, and a tool with no read-only hint is a
   write.
8. **No server-side smoke render in the first release.** Executor renders the
   component once with React on the server. Solus refuses code that does not
   compile and reports a first-render error from the frame's error boundary.
   A server render needs React in the server bundle; revisit if agents keep
   saving components that crash on mount.
9. **Roles are not stored.** They are read from the source on every read and
   every call, so a stored list can never disagree with the code, and
   `update_work` needs no second write.
10. **Not taken:** Executor's custom tool apps, QuickJS, workerd, and deploy
    tokens. An app is UI over existing tools. Nothing of it runs on the server
    but the compile and the call check.

## 3. Data

`WorkType` gains `'app'`. `Work.content` is the component source. Work meta
gains one optional field:

```ts
interface AppMeta {
  permissions: AppPermissions
}
interface AppPermissions {
  tools: 'all' | 'read-only' | { selected: string[] }   // selected: "<slug>/<tool>"
  writes: 'ask' | 'allow'
}
```

Default permissions: `{ tools: 'all', writes: 'ask' }`. The meta rides the
`meta` JSON column (`work-rows.ts` `workExtraSchema`), so no migration.

Role extraction (`packages/server/src/apps/app-source.ts`): every
`tools.<slug>` and `tools["<slug>"]` reference in the source with comments
blanked, first use first, repeats collapsed.

## 4. The shell

`packages/app-shell/src/`:

- `shell.tsx` — mounts the component under a `QueryClientProvider`, an error
  boundary, and the Solus theme; connects to the host over the MCP Apps
  protocol (`ui/initialize`, `ui/notifications/initialized`, `tools/call`,
  `ui/notifications/size-changed`, `ui/notifications/host-context-changed`).
- `host-bridge.ts` — the frame's side of that protocol. Every message is
  parsed at this boundary.
- `tools-proxy.ts` — the `tools` object: `tools.<slug>.<tool>(args)` calls;
  `.queryOptions(args)`, `.queryKey(args)`, `.mutationOptions()`, and
  `.pathFilter()` for TanStack Query, keyed by path so a mutation can
  invalidate its reads. Ported from Executor's `tools-proxy.ts`, without the
  role form and the infinite variants.
- `modules.ts` — what `require` answers: `react`, `react/jsx-runtime`,
  `react-dom`, `@tanstack/react-query`, `recharts`, `lucide-react`, and
  `@solus/app` (`tools`, `useApp()` with the roles and their state, and the UI
  primitives). Anything else throws a named error the boundary shows.
- `ui/` — Button, Card, Input, Select, Badge, Table, Tabs, Skeleton, Empty,
  Stat, styled with the Solus variables.
- `theme.css` — the Tailwind entry and the token bridge.

The document the server composes (`apps/app-shell.ts`):

```html
<style>/* both Solus palettes; the shell switches with data-theme */</style>
<div id="solus-app-root"></div>
<script>/* shell.js */</script>
<script>SolusAppShell.define(function (require, module, exports) { /* compiled component */ })</script>
<script>SolusAppShell.mount({ roles, permissions })</script>
```

The compiled component is an inline script, so nothing is evaluated from a
string: the MCP App policy (`mcpAppDocument`) has no `unsafe-eval` and no
`connect-src`. The `tools` proxy is the only way out.

## 5. Permissions

Set by `create_app`, shown and changed in the app's header.

| Setting | Values | Default |
|---|---|---|
| Tools | `all`, `read-only`, `selected` (a list of `<slug>/<tool>`) | `all` |
| Writes | `ask` (approval on each write), `allow` | `ask` |

`toolInfo(name)` answers from the current state, on every call:

- `callable` — the slug is one of the app's roles, the caller owns an
  integration with that slug, the tool exists there and is not turned off,
  and the permissions admit it (`read-only` admits a tool with
  `readOnlyHint`; `selected` admits a listed name).
- `readOnly` — the tool's `readOnlyHint`, or `writes: 'allow'`. The frame host
  asks approval when it is false. `allow` makes a write run on interaction;
  the header says so.

A change of permissions is a work meta update and takes effect on the next
call.

## 6. Server

`packages/server/src/apps/` (a focused domain, like `review/`):

- `app-source.ts` — role extraction and the sucrase compile. Pure.
- `app-permissions.ts` — `admits` (§5). Pure.
- `app-shell.ts` — reads the built shell once, composes the document (§4).
- `apps.ts` — `Apps`: `read(workId)` → snapshot; `toolInfo`; `callTool`;
  `permissionsUpdate`. Loads the work in the caller's scope, so another
  person's id does not resolve. Resolves the role to the caller's own
  integration, checks the permissions and the tool's current hints, and calls
  `gateway.callAppTool`. The result is bounded like an MCP App's.
- `transport/handlers/app-handlers.ts` — `appRead`, `appToolInfo`,
  `appCallTool`, `appPermissionsUpdate`; `rpc-planes` `execution`;
  `access-policy` keyed by the work.
- `execution/agents/tools/app-tools.ts` — `create_app`: `title`, `code`,
  `permissions?`, `work_id?` with `expected_content_version` (update in
  place). The toolbox lists it under `apps.create`.

Contract: `packages/contracts/src/apps.ts` holds the schemas above and the
request and snapshot shapes; `host-api.ts` the four methods.

## 7. Clients

- **Desktop and web.** `WorkPane` opens `app` works in `AppShell.svelte`
  (`components/app/`): the works header, the two permission selects, the
  connect notice, and the frame. The frame is `McpAppFrame.svelte` given app
  calls. The conversation shows the `work_created` card as today. The works
  list and the workspace items know the type.
- **Mobile.** The thread feed shows an app row for `work_created`,
  `work_updated`, and a `create_app` receipt in history. The row runs the app
  in the MCP App web view given app calls, with the permissions as one line.

## 8. Entry points and reverse states

- In: `create_app` from the agent. Out: delete the work. Update:
  `create_app` with `work_id`, or `update_work` with new source.
- Permissions: set, shown, changed; `read-only` is the way back from `all`.
- States: shell missing, compile error, role not connected, tool turned off,
  write declined, result too large, integration removed. Each is a message in
  the pane, the frame, or the tool result, never a blank frame.

## 9. Next: sharing and deployment

Not started. The call path stays the same; the host becomes the Solus API.

- **Share** is the existing cloud copy of a work. The link opens the same
  shell on the Solus API and roles resolve to the signed-in viewer's own
  cloud connections (`docs/plans/cloud-vault.md`).
- **Deploy** is a standalone web app at its own URL. Build `/mcp` on the Solus
  API (and the host) as the one door for every client that is not Solus, and
  make the deployed app its first consumer: the shell's bridge gets a second
  transport, HTTP in place of `postMessage`. Take T3 Code's credential and
  grant design for it (`McpSessionRegistry`, `McpToolAccess`, `McpOAuth`): a
  token scoped to one app and one person, each tool declared a read or a
  write, a grant that is read-only or a ceiling. Do not take T3's app-call
  path through the provider session; the gateway stays the owner of
  integrations.
- Access is a deployment setting: organization members sign in and use their
  own connections; a public deployment runs on the owner's connections
  through explicit per-connection grants with a visible banner. The public
  mode is the one real trust decision and ships last.

## 10. What shipped on 2026-11-11

- `packages/app-shell/` and `scripts/build-app-shell.ts` (`bun run
  build:app-shell`), run by `scripts/dev.sh` and `scripts/build-parallel.sh`,
  and copied by `scripts/package-server.ts`; the desktop app ships
  `resources/**` already. Output `resources/app-shell/shell.js`, about 2.4 MB.
- `packages/contracts/src/apps.ts`; `WorkType` `'app'` in every enum copy;
  `appRead`, `appToolInfo`, `appCallTool`, `appPermissionsUpdate`.
- `packages/server/src/apps/`; `create_app` (`solusToolbox.apps.create`); the
  history projection reads a `create_app` receipt into `artifactWorkRef`.
- Desktop and web: `components/app/`; `McpAppFrame.svelte` takes `calls`.
  Mobile: `ThreadApp.tsx`; `McpAppWebView` takes `calls`.
- `tests/unit/apps.test.ts`. The shell was rendered in headless Chromium with
  a scripted host in both themes.

Not in this release: the `selected` tools list has no picker in the header (an
agent sets it through `create_app`); a work in an organization's Solus API
keeps the default permissions until the app's page sets them; the mobile
works list has no app screen, as it has none for any work.
