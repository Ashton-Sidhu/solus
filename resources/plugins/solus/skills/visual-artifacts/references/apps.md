# Apps

An app is a small program that lives in Solus, on the user's host. It has a backend, its own SQLite data, and a UI. It works when nobody looks at it: the user, their agents, a schedule, and a webhook all call the same operations.

Build whatever the user asked for, at the size they asked for. Do not reduce the request to one screen, or to what one data source offers.

The project, the UI build, the design guidelines, and the preview are the ones in the skill's main file. This chapter adds the backend and what an app's UI has that a visual in a reply does not.

| Part | Where | What it is |
|---|---|---|
| Operations | `app.ts` | Typed queries and mutations. The UI calls them, and each one is a tool for an agent. |
| Data | `migrations/*.sql` | The app's own SQLite database. |
| Schedules | `app.ts` | A timer that runs a mutation with no person there. |
| Webhooks | `app.ts` | A URL another service calls; it runs a mutation. |
| Secrets | `app.ts` | Values the user gives once, such as a database URL. Only the backend reads them. |
| Integrations | `app.ts` | The user's connected services, by slug. |
| UI | `src/` | A full application in its own window. An app can have no UI. |
| Storage | `@solus/app` | Key-value data for a UI that needs no backend. |

Each part is optional. A to-do list needs only a UI and `storage`. A database browser needs operations, a secret, and a network permission. A digest that posts each morning needs an operation and a schedule, and no UI.

## Steps

1. Start the project with the skill's initializer, as for any artifact.
2. Add `app.ts` next to `package.json`. It makes the project an app.
3. Add `migrations/0001_<name>.sql` when the app keeps data.
4. Write the UI in `src/` with `@solus/app` for its data and `@solus/ui` for its controls.
5. `npm run bundle`. With an `app.ts`, the build also writes `dist/app/`.
6. Check the UI: `preview_app` with `path` (the project folder). Fix what the screenshot shows. Check each page with `route`, and check about 390px wide and dark mode too.
7. Deploy: `deploy_app` with `path`. A deploy makes the version active at once and links the app to this session. The receipt says the app's slug.
8. Change an app later: `deploy_app` with `path` and `app: "<slug>"`. In a later session, get the source first with `checkout_app`, then `npm install`.

Do not use `render_artifact` for an app.

## app.ts: the backend

```ts
import { defineApp, mutation, query } from '@solus/app/backend'
import { z } from 'zod'

interface Note { id: string; text: string; created_at: number }

export default defineApp({
  name: 'Notes',
  description: 'A list of notes.',
  operations: {
    list: query(
      { description: 'The 100 newest notes.' },
      (ctx) => ctx.sql.exec<Note>('SELECT id, text, created_at FROM notes ORDER BY created_at DESC LIMIT 100').all(),
    ),
    add: mutation(
      { description: 'Save one note.', input: z.object({ text: z.string().min(1) }) },
      (ctx, input) => ctx.sql.exec<Note>(
        'INSERT INTO notes (id, text, created_at) VALUES (?, ?, ?) RETURNING id, text, created_at',
        crypto.randomUUID(), input.text, Date.now(),
      ).one(),
    ),
  },
})
```

- A **query** reads. It gets a read-only database, so a write in a query fails. It may still call a service.
- A **mutation** writes. When it changes the database, every open UI of the app runs its queries again.
- `input` is a Zod object schema. Solus refuses input it does not accept, for every caller. Omit it for an operation that takes nothing.
- `description` is what an agent reads to choose the tool. Write one sentence for each operation.
- A handler takes `(ctx, input)` and returns a JSON value, at most 1 MiB. Page large results. A call has 60 seconds.
- A thrown error reaches the caller as its message. Write messages a person can act on.
- An operation never asks the user first. Do not build a confirm step into the backend; put it in the UI where it matters.

### ctx

| Field | What it is |
|---|---|
| `ctx.sql` | The app's database. `exec(sql, ...values)` runs one statement and gives `.all()` and `.one()`. `transaction(fn)` groups statements; `fn` is synchronous, so do network work before or after it. |
| `ctx.secrets` | The values the user gave, by name. One that is not set is `undefined`: throw an error that says which one to set. |
| `ctx.tools` | The integrations the app names: `await ctx.tools.linear.list_issues({ team: 'ENG' })`. |
| `ctx.files` | A folder that is the app's own, always readable and writable. |
| `ctx.caller` | Who called: `{ kind: 'ui' }`, `'agent'`, `'schedule'`, or `'webhook'`. |

The backend runs in the app's own Node process on the host. It starts on a call and stops when idle, so keep no state in memory that the app cannot rebuild. It may use Node's built-in modules and any npm package: install it with `npm install` and the build bundles it. It cannot start a process, start a worker, or load a native add-on. Pick a package written in JavaScript (`pg`, not a native driver).

## Data: migrations

```sql
-- migrations/0001_notes.sql
CREATE TABLE notes (
  id TEXT PRIMARY KEY NOT NULL,
  text TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX notes_created ON notes (created_at);
```

- Name a file with four digits, an underscore, and a lower-case name: `0002_add_done.sql`. Solus applies new files in number order when a version becomes active, each in one transaction. Do not write `BEGIN` or `COMMIT` in a file.
- Never edit a migration that a deployed version has. Add a new file.
- A migration that fails stops the deploy. The version before it keeps running, and the receipt says the SQLite error.
- A deploy never deletes data. An earlier version can be made active again, and it then runs against the newer schema: write changes that old code can live with (add a column with a default; do not rename one in the same step).

## Schedules

```ts
schedules: {
  digest: { cron: '0 9 * * 1-5', timezone: 'America/Toronto', run: 'sendDigest' },
  sync: { every: { minutes: 30 }, run: 'sync', input: { full: false } },
},
```

A schedule runs one mutation of the app with the `input` you give. It is on from the deploy that declares it; the user can pause it in the app's menu. It runs as the app's owner, with `ctx.caller.kind === 'schedule'`. A run that fails is in the app's call log and does not retry. On a desktop host a schedule fires only while Solus is open; say so when the user expects it to run at night.

## Webhooks

```ts
import { webhookRequest } from '@solus/app/backend'

operations: {
  onIssue: mutation({ description: 'Save an issue GitHub sent.', input: webhookRequest }, (ctx, request) => {
    if (request.headers['x-github-event'] !== 'issues') return null
    // request.body is the JSON GitHub sent
  }),
},
webhooks: {
  issues: {
    verify: {
      scheme: 'hmac', algorithm: 'sha256', signedText: '{{body}}',
      signature: { source: { kind: 'header', name: 'x-hub-signature-256' }, format: { encoding: 'hex', prefix: 'sha256=' } },
    },
    replayKey: '{{headers.x-github-delivery}}',
    run: 'onIssue',
  },
},
```

A deploy makes a webhook for each declaration. Solus checks the signature before the mutation runs, drops a second delivery with the same `replayKey`, and keeps a log of deliveries. The mutation gets `{ headers, query, body }`: header names are lower case, and `body` is JSON when the request was JSON. Answer fast: store the event and return.

The app's menu shows each webhook's URL and its signing secret. Tell the user to copy both into the other service. When the other service gives its own secret, the user sets it in Settings → Webhooks. The verification schemes are the ones of `create_webhook`: `hmac`, `public_key`, `token`, `jwt`, `standard_webhooks`, and `none` with a reason.

## Secrets

```ts
secrets: { database: { label: 'Database URL', description: 'A Postgres URL that this app may read.' } },
```

Declare a value the app needs from the user and must not show: a database URL, an API key. The user sets it in the app's menu, and the receipt of a deploy says which are not set. Never ask for a secret in the UI, and never keep one in `storage` or in the database.

## Integrations

```ts
integrations: ['linear', 'github'],
```

Name each integration the app calls, by the slug `connection_status` shows. The backend calls `ctx.tools.<slug>.<tool>(input)`, and the UI can call `tools.<slug>.<tool>(input)` from `@solus/app`. Each call runs with the caller's own connection; a schedule and a webhook run with the owner's. A call answers the tool's structured content, or its text parsed as JSON. A call to an integration the user has not connected fails with a message that says to connect it; show that message.

## Permissions

```ts
permissions: {
  network: ['api.example.com', 'db.internal:5432'],
  files: { read: ['~/Documents/data'], write: [] },
},
```

- `network`: hosts the backend and the UI reach. A host, a host with a port, `*.example.com`, or `'*'` for every host.
- `files`: absolute or `~/` host paths the backend reads and writes. `'*'` is every path. A path it may write, it may read.

The app's own database and `ctx.files` need no permission. Solus refuses a host or a path the app did not declare, and the app's header shows what it declares. Ask for exactly what the app uses: a database browser that takes any URL needs `network: ['*']`; one for a single known database needs that one host. Open a SQLite file of the user's that you only read with `{ readOnly: true }`.

## The UI

```tsx
import { appClient } from '@solus/app'
import type app from '../app'

const api = appClient<typeof app>()

export default function App() {
  const notes = api.useQuery('list', {})
  // notes.data, notes.error, notes.loading, notes.refresh()
  const add = (text: string) => api.mutate('add', { text })
}
```

- `appClient<typeof app>()` gives `query`, `mutate`, and `useQuery` with the names, inputs, and outputs of `app.ts`. The import is a type, so no backend code is in the UI.
- `useQuery` runs again when its input changes and when the app's data changes, from this UI, another open UI, an agent, a schedule, or a webhook. Keep `data` on screen while a later run loads.
- Show a loading state, an empty state, and the error of a failed call with a way to try again.
- `storage` from `@solus/app` is key-value data for a UI with no backend: `storage.get`, `set`, `delete`, `keys`. A value is at most 1 MiB and the whole app holds 8 MiB. Use the database for anything a schedule or an agent also reads.
- An app's page has no network but the hosts in `permissions.network`, over HTTPS. Load nothing from a CDN: import fonts, scripts, and images from source so the build puts them in the page. For a service that does not allow cross-origin requests, call it from an operation.

For an app with no UI, set `ui: false` in `defineApp`. Its surface in Solus lists its operations.

### Look like a part of Solus

An app opens inside Solus, beside conversations, diffs, and tasks. It must read as one more pane of Solus, not as a web page in a frame. Solus gives an app's window its own chrome colors and its own type scale, and the template has the controls:

```tsx
import { Badge, Button, Checkbox, Empty, Field, Input, Notice, Segmented, Select, Sidebar, SidebarItem, SidebarLabel, Table, Td, Textarea, Th, Toolbar, Tr } from '@solus/ui'
```

- **Use `@solus/ui` for every control.** A button is 32px tall, a row is 32px, the radius is 8px, and the hover wash, hairlines, and focus ring are the workspace's. Do not write your own button, input, or list row, and do not change a control's color, height, or radius with `className`. When the app needs a control that is not there, add it to your own file in the same style.
- **Do not draw the app's name.** Solus shows the name, the version, and the menu above the window. Start with your navigation or your content. A `Toolbar` names the open view ("All notes"), not the app.
- **Text is 14px (`text-sm`, the default). Secondary text is 12px (`text-xs text-muted-foreground`).** A view title is `text-sm font-medium`. Use nothing larger, and no heading scale, no hero, no marketing copy.
- **Color comes from the tokens:** `bg-background`, `text-foreground`, `text-muted-foreground`, `border-border`, `bg-muted` (the hover wash), `bg-sidebar`, `bg-primary` (one solid button in a view, for its main action). No gradient, no shadow on a panel, no card inside a card, no colored panel backgrounds.
- **Layout is panes, not a page.** `h-dvh` root, a `Sidebar` for navigation when there is more than one view, a `Toolbar` over each view, and content that scrolls under it. Split with hairlines (`border-border`), not with boxes and gaps. A form is a narrow column of `Field`s in the view, not a centered card.
- **Density is the workspace's.** Padding inside a view is `p-2` or `p-3`. A list is rows of 32px with `hover:bg-muted`, not cards. A table uses `Table`, `Th`, `Tr`, `Td`.
- **States are quiet.** `Empty` for nothing to show, with the one thing to do next. `Notice tone="danger"` for an error, with a way to try again. No spinner that fills the window: keep the last data on screen while a query runs.
- Icons are inline SVG at 16px, in the text color. Motion is a color transition only.

In `rem`, a size here is the size Solus's own controls have (the root is 16px), so the Tailwind scale means what it means in Solus: `h-8` is 32px and `text-sm` is 14px.

### The app's window

A visual in a reply is a document: it is as tall as its content and has no shell. An app is not. It gets a window of a fixed size and lays out everything inside it:

- On desktop and web the window is all of the pane the app opens in. On a phone it opens full screen.
- Fill it. Give the root `min-h-dvh` or `h-dvh`, and build the shell the app needs: a sidebar, a header, a toolbar, a footer that stays in place. Let the content region scroll (`overflow-auto`), or let the page scroll. `100vh` and `100dvh` are the window here, so the main file's rule against them does not apply to an app.
- The window can be 360px wide or 1400px wide. Design both: a sidebar that becomes a top bar or a menu, a table that scrolls sideways. Use container queries or wrapping layouts.
- The app has its own navigation, and no title bar of its own: Solus draws the app's name above the window. The tokens follow light and dark mode.

### Pages

An app with more than one screen has pages. The whole UI is one built file, so the pages are routes inside it:

- Keep the page in the address after `#`: `#/customers`, `#/customers/42`, `#/settings`. Read `location.hash`, listen for `hashchange`, and link with `<a href="#/customers/42">`. A link that starts with `#` stays in the app; any other link opens outside it.
- To move from code, assign the fragment: `location.hash = '#/customers/42'`. Do not use `location.assign`, `location.replace`, or `history.pushState` with an address: the page runs in a frame that has no address of its own, so they fail or load something else. For the same reason a routing library needs its in-memory router (`createMemoryRouter` in React Router), not its hash or browser router.
- Every page handles a reload: it loads what it shows with a query by what is in the address, not from state another page left in memory.
- Give every page a way back, and show which page is open in the navigation.

## Preview

`preview_app` opens the UI in a window 800px tall, at the width you ask for (1100px by default), answers its calls, and takes a picture of the window. `route` opens one page. Nothing is deployed, and it needs no approval.

- Operations run for real, against a new, empty database with the project's migrations. So the first picture shows the empty state. To see the app with data, check the empty state first, then deploy; from your next turn each operation is a tool you can call.
- A secret is not set in a preview, and an integration is not called. Design those states from the known shapes, and say that the live view was not checked.
- `storage` works in memory.

Try an operation's SQL before you deploy: `sqlite3` or `node:sqlite` in a scratch file is faster than a deploy.

## After the deploy

- Each operation is a tool named `<slug>__<operation>` from the next turn of any session on the host. Tell the user that their agents can now use the app, and name one thing to ask for.
- `list_apps` says what the host has: each app's slug, its active version, its operations, and what needs the user.
- When the receipt says a secret is not set, tell the user to set it in the app's menu, under Secrets.
- When the receipt says the version did not start, the version before it still runs. Fix the cause and deploy again with `app: "<slug>"`.

## Design for an app

The accessibility and motion rules of the main file apply. Its layout, type, and color rules are for a visual in a reply; for an app, "Look like a part of Solus" and "The app's window" replace them. Do not load a general design skill to restyle an app: an app takes the look of Solus.

An app has more states than a visual, so check each one in a preview: first open with no data, loading, an error from an operation with a way to try again, a long list, every page, and a narrow window. Show real data; never put a hard-coded array where live data belongs.
