# Apps

An app is an artifact with a host behind it. The project, the build, the design rules, the preview, and the revision flow are the ones in the skill's main file. This chapter adds only what an app has that a plain artifact does not.

Build whatever the user asked for. Do not reduce the request to what one data source offers.

| | What it is | Needs the user to allow it |
|---|---|---|
| `storage` | The app's own JSON data, kept on the host | No |
| `fetch` | The network, to the hosts the app names | Yes |
| `server` | The app's own functions, which run on the host | Yes |
| `tools` | The user's connected integrations, with their own account | No; a write asks each time |

Each is optional. Integrations are the easy way to data the user already connected; they are not what makes something an app. A to-do list needs only `storage`. A database browser needs `server`. A view of Linear issues needs `tools`.

## Make the project an app

1. Add `app.json` next to `package.json`. An empty object is enough:

   ```json
   {}
   ```

2. Import what you need from `@solus/app`. The template already has it:

   ```tsx
   import { storage, server, tools } from '@solus/app'
   ```

3. For code on the host, add `server.ts` next to `package.json`.
4. `npm run bundle` as always. With an `app.json`, the build writes the app's manifest into `bundle.html`.
5. Check it: `create_app` with `html_path` and `preview: true`. Fix what the screenshot shows. Check about 390px wide and dark mode too.
6. Save it: `create_app` with `title` and `html_path`. Do not use `render_artifact` for an app.
7. Revise it: `update_work` with `work_id`, `html_path`, and `expected_content_version`, as for any artifact.

When a receipt says the app waits for host access, tell the user to press **Allow** in the app's header. Until then, host functions, the network, and writes that do not ask do not work.

## storage

```ts
await storage.set('todos', todos)                  // any JSON value: 1 MiB a value, 8 MiB for the whole app
const todos = await storage.get<Todo[]>('todos')   // null when there is none
await storage.delete('todos')
const keys = await storage.keys()
```

The data belongs to the app, not to a viewer, and stays when the app is revised. When a revision changes the shape of stored data, read the old shape too. Load it in an effect or a query, show a loading state while it loads, and show a failure when a write fails.

## server: host functions

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
const names = await server.tables<string[]>({ path })
```

- It runs in the app's own Node process on the host, started on the first call and stopped when idle. Keep no state in memory that the app cannot rebuild.
- The second argument is `{ dataDir }`: a folder that is the app's own, always readable and writable. Put the app's files and its own SQLite database there.
- It may use Node's built-in modules and any npm package: install it with `npm install` and the build bundles it. It cannot start a process, start a worker, or load a native add-on. Pick a package written in JavaScript (`pg`, not a native driver), or a Node built-in such as `node:sqlite`.
- It reads and writes only the paths in `permissions.files`, and reaches only the hosts in `permissions.network`. Open a SQLite file you only read with `{ readOnly: true }`; a writable open needs write access to that path.
- A call has 60 seconds and its result is at most 1 MiB. Page large results; never return a whole table.
- A thrown error reaches the page as the rejected promise's message. Write messages a person can act on.
- Only the owner of the host can run host functions. An app that has them cannot be shared or deployed yet. Say so when the user plans to share the app.

Try a host function before you save. Node 24 or later runs TypeScript directly:

```sh
node -e "import('./server.ts').then(async (m) => console.log(await m.tables({ path: '/path/to/file.db' }, { dataDir: '/tmp' })))"
```

## fetch and the network

An app's page has no network but the hosts in `permissions.network`, over HTTPS, and only after the user allowed them. This is stricter than a plain artifact, because an app can read the user's integrations. So:

- Load nothing from a CDN: no remote font, script, stylesheet, or image. Import them from source so the build puts them in the page.
- An image whose URL comes from data (an avatar from an API) loads only from an allowed host. Name that host, or show initials.
- The browser's CORS rules apply to `fetch`. For a service that does not allow cross-origin requests, call it from a host function.

## tools: integrations

```tsx
const issues = await tools.linear.list_issues<Issue[]>({ team: 'ENG' })
await tools.github.create_issue({ repo, title })
```

`<slug>` is the integration's slug from `connection_status`; `<tool>` is the upstream tool's name. Each call runs with the viewer's own connection. Name no account and no credential. A call answers the tool's structured content, or its text parsed as JSON. A call to an integration the viewer has not connected fails with a message that says to connect it; show that message.

## Permissions and host access

`app.json` declares what the app needs. Ask for the least.

```json
{
  "permissions": {
    "tools": "all",
    "writes": "ask",
    "network": ["api.example.com", "db.internal:5432"],
    "files": { "read": ["~/Documents/data"], "write": [] }
  }
}
```

- `tools`: `"all"` (default), `"read-only"`, or `{ "selected": ["<slug>/<tool>"] }`.
- `writes`: `"ask"` (default: the user approves each integration write) or `"allow"`.
- `network`: hosts the app reaches from the page and from host functions. A host, a host with a port, `*.example.com`, or `"*"` for every host.
- `files`: absolute or `~/` host paths for host functions. `"*"` is every path. A path it may write, it may read.

Host functions, network hosts, file paths, and `"writes": "allow"` together are the app's **host access**. None of it is in force until the owner of the host allows it in the app's header. A revision that asks for more, or that changes `server.ts` or anything it bundles, asks again; a change of the page alone does not. So:

- Ask for exactly what the app uses. A database browser that takes any URL needs `"network": ["*"]`; one for a single known database needs that one host.
- When the app must take a value from the user (a database URL, a folder, a base URL), ask for it in the app's own page and keep it in `storage`. Solus has no built-in database connection for an app to borrow.
- A value kept in `storage` is on the user's host and readable by the app's page. When it is a password or a key, say so to the user.

## Preview

`create_app` with `preview: true` renders the app and answers its calls before it takes the picture:

- `storage` works in memory. With `work_id`, reads come from the saved app's storage; nothing is written.
- A host function runs only for a saved app the user already allowed, with the same host code. Pass `work_id`. So the order for an app with host functions is: save, ask the user to allow it, then iterate on the page with real data in every preview. Before that, the preview shows your loading and error states, which you must design anyway.
- An integration is not called in a preview. Design the states from the tool's known shape, and say that the live view was not checked.

## Design for an app

The design section of the main file applies. An app has more states than a visual, so check each one in a preview: first open with no data, loading, an error from a host function or a tool with a way to try again, a long list, and a narrow pane. Show real data; never put a hard-coded array where live data belongs.

## Revise an app

`read_work` on an app answers its sources, not the built page. Put them in a project (the one you still have, or a new one from the initializer), run `npm install` for the packages its `package.json` names, change, build, preview, and call `update_work`. The app's storage and its `dataDir` stay.
