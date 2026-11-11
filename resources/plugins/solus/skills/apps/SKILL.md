---
name: apps
description: Build an app that lives in Solus — a tool the user opens on desktop, web, and mobile, saved as a work. An app keeps its own data, can use any npm package, can run its own code on the host (databases, files, anything Node does), and can use the user's connected integrations. Use when the user asks for an app, a tool, a tracker, a browser or admin view for their data, or a dashboard over live data, and does not ask for a codebase. Use building-for-web for a web project to deploy; use visual-artifacts for a one-time chart or visual.
---

# Apps

An app is something the user keeps and opens again. It is a Solus work: it opens from the conversation and the works list on desktop, web, and mobile, and you revise it in place. Build whatever the user asked for. Do not reduce the request to what one data source offers.

An app has four things to build with. Each is optional.

| | What it is | Needs the user to allow it |
|---|---|---|
| `storage` | The app's own JSON data, kept on the host | No |
| `fetch` | The network, to the hosts the app names | Yes |
| `server` | The app's own functions, which run on the host | Yes |
| `tools` | The user's connected integrations, with their own account | No; a write asks each time |

Integrations are the easy way to data the user already connected. They are not what makes something an app. A to-do list needs only `storage`. A database browser needs `server`. A dashboard over Linear needs `tools`.

## Two forms

**One component.** For a small app that needs only `storage`, `fetch`, `tools`, and the libraries the shell has, call `create_app` with `code`: one TSX module that default-exports a React component. No project, no build. The tool's description lists what it may import.

**A project.** For anything larger, any other npm package, several files, or code on the host, use the workflow below. It ends with `create_app` and `bundle_path`.

When unsure, use a project. It can do everything the component form does.

## Workflow

Resolve this skill's directory from the path used to load it. Node.js 22 or later and npm are required. Nothing is installed globally.

### 1. Initialize

Choose a new directory outside the user's source tree unless they asked to keep the app's source in the project.

```sh
node "<skill-dir>/scripts/init-app.mjs" "<new-app-directory>"
```

It creates a React and TypeScript project with a working starter, the types of `@solus/app`, pinned dependencies, and the build script. It refuses to replace an existing directory.

### 2. Develop

- `src/App.tsx` default-exports the app's React component. Add files and folders under `src/` as the app grows.
- `server.ts`, next to `package.json`, holds the host functions. Create it only when the app needs code on the host.
- Install any package the app needs with `npm install <package>`. The build bundles it. A package with a native add-on does not work in a host function; pick one written in JavaScript, or a Node built-in such as `node:sqlite`.

React, React DOM, TanStack Query, Recharts, Lucide, and `@solus/app` come from the Solus shell at run time. Import them as usual; do not add a second copy of React. Tailwind classes work with no setup: the shell compiles them in the page.

### 3. Build

```sh
npm run bundle
```

This typechecks, bundles `src/App.tsx` for the frame and `server.ts` for Node, and writes `app.bundle.json`. A failed build leaves the last bundle in place; do not save that stale file.

### 4. Save

Call `create_app` with `title` and `bundle_path` set to the `app.bundle.json` path. Pass `permissions` when the app needs the network or host files (see below). Do not read the bundle into your output.

Tell the user what the app does and, when the receipt says the app waits for host access, that they must press **Allow** in the app's header before those parts work.

## What an app builds with

Everything comes from `@solus/app`:

```tsx
import { storage, server, tools, useApp, Button, Card } from '@solus/app'
```

### storage

```ts
await storage.set('todos', todos)            // any JSON value, up to 8 MiB for the whole app
const todos = await storage.get<Todo[]>('todos')   // null when there is none
await storage.delete('todos')
const keys = await storage.keys()
```

The data belongs to the app, not to a viewer, and stays when the app is revised. Read it through TanStack Query so the page has loading and error states, and invalidate the query after a write.

### server: host functions

Each function `server.ts` exports is a host function. It takes one JSON object and returns a JSON value.

```ts
// server.ts
import { DatabaseSync } from 'node:sqlite'

export async function tables({ path }: { path: string }): Promise<string[]> {
  const db = new DatabaseSync(path, { readOnly: true })
  try {
    return db.prepare("select name from sqlite_master where type = 'table' order by name").all().map((row) => String(row.name))
  } finally {
    db.close()
  }
}
```

```tsx
// src/App.tsx
const tables = useQuery(server.tables.queryOptions<string[]>({ path }))
const run = useMutation(server.insertRow.mutationOptions())
queryClient.invalidateQueries(server.rows.pathFilter())
```

Rules of a host function:

- It runs in the app's own Node process on the host, started on the first call and stopped when idle. Keep no state in memory between calls that the app cannot rebuild.
- The second argument is `{ dataDir }`: a folder that is the app's own, always readable and writable. Put the app's files and its own SQLite database there.
- It may use Node's built-in modules and any bundled npm package. It cannot start a process, start a worker, or load a native add-on.
- It reads and writes only the paths in `permissions.files`, and reaches only the hosts in `permissions.network`. Open a SQLite file you only read with `{ readOnly: true }`; a writable open needs write access to that path.
- A call has 60 seconds and its result is at most 1 MiB. Page large results; never return a whole table.
- A thrown error reaches the frame as the rejected promise's message. Write messages a person can act on.
- Only the owner of the host can run host functions. An app that has them cannot be shared or deployed yet. Say so when the user plans to share the app.

Try a host function before you save the app. Node 24 or later runs TypeScript directly:

```sh
node -e "import('./server.ts').then(async (m) => console.log(await m.tables({ path: '/path/to/file.db' }, { dataDir: '/tmp' })))"
```

### fetch: the network

The frame's own `fetch` reaches only the hosts in `permissions.network`, over HTTPS, and the browser's CORS rules apply. For a service that does not allow cross-origin requests, or one that needs a key the page must not hold, call it from a host function instead.

### tools: integrations

```tsx
const issues = useQuery(tools.linear.list_issues.queryOptions({ team: 'ENG' }))
const create = useMutation(tools.github.create_issue.mutationOptions())
```

`<slug>` is the integration's slug from `connection_status`; `<tool>` is the upstream tool's name. Each call runs with the viewer's own connection. Name no account and no credential. A viewer who has not connected the integration sees a connect notice; `useApp().roles` says which are connected. A call answers the tool's structured content, or its text parsed as JSON.

## Permissions and host access

Pass `permissions` to `create_app`. Ask for the least the app needs.

```json
{
  "tools": "all",
  "writes": "ask",
  "network": ["api.example.com", "db.internal:5432"],
  "files": { "read": ["~/Documents/data"], "write": [] }
}
```

- `tools`: `"all"` (default), `"read-only"`, or `{ "selected": ["<slug>/<tool>"] }`.
- `writes`: `"ask"` (default: the user approves each integration write) or `"allow"`.
- `network`: hosts the app reaches from the frame and from host functions. A host, a host with a port, `*.example.com`, or `"*"` for every host.
- `files`: absolute or `~/` host paths for host functions. `"*"` is every path. A path it may write, it may read.

Host functions, network hosts, and file paths together are the app's **host access**. None of it is in force until the owner of the host allows it in the app's header. A revision that asks for more asks again. So:

- Ask for exactly what the app uses. A database browser that takes any URL needs `"network": ["*"]`; one for a single known database needs that one host.
- When the app must take a value from the user (a database URL, a folder, a base URL), ask for it in the app's own page and keep it in `storage`. Solus has no built-in database connection for an app to borrow.
- A value kept in `storage` is on the user's host and readable by the app's page. When it is a password or a key, say so to the user.

## Design

The frame is the app's page: it is as wide as the pane it opens in, and as tall as its content. Do not use `100vh`, a fixed page shell, or a maximum-width column for the whole app.

- Use the Solus palette through Tailwind: `bg-background`, `bg-card`, `bg-secondary`, `text-foreground`, `text-muted-foreground`, `border-border`, `bg-primary` with `text-primary-foreground` for the main action, `text-destructive`, `text-success`, `text-warning`, and `chart-1` to `chart-6` for data. It follows light and dark mode. Do not hard-code colors.
- Start from the primitives in `@solus/app`: Button, Card, CardTitle, CardDescription, Input, Select, Badge, Table, TableHead, TableBody, TableRow, TableHeader, TableCell, Tabs, Skeleton, Empty, Stat. Compose them with Tailwind utilities.
- Every query has a loading state, an empty state, and an error state with a way to try again. Every mutation shows its failure.
- Show real data. Never put a hard-coded array where live data belongs.
- Every control is reachable by keyboard and has a visible label or an `aria-label`. Use container queries or wrapping layouts; the pane can be 360px wide.
- No continuous animation.

## Revise an app

1. `read_work` with the app's `work_id`. It answers the current `content_version` and, for a project app, its sources.
2. Use the project folder if you still have it and it matches those sources. If not, run `init-app.mjs` for a new folder, write the sources into it, and run `npm install` for the packages its `package.json` names.
3. Change, `npm run bundle`, then `create_app` with `work_id`, `expected_content_version`, and `bundle_path`. Do not create a second app.
4. The app's storage and its `dataDir` stay. When a revision changes the shape of stored data, read the old shape too.

## Verify

The build checks types and packaging. It does not check that the app works.

- Run each host function once with real input, as shown above.
- Check the states: first open with no data, an error from a host function or a tool, a long list.
- State plainly what you did not check. Do not claim the app was opened if it was not.
- Do not start a server or open a browser without the user's agreement.
