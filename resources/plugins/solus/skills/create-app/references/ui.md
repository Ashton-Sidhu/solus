# The UI

## The client

```tsx
import { appClient } from '@solus/app'
import type app from '../app'

const api = appClient<typeof app>()

export default function App() {
  const notes = api.useQuery('list', { search: '' })
  // notes.data, notes.error, notes.loading, notes.refresh()
  const add = (text: string) => api.mutate('add', { text })
}
```

- `appClient<typeof app>()` gives `query`, `mutate`, and `useQuery` with the names, inputs, and outputs of `app.ts`. The import is a type, so no backend code is in the UI.
- `useQuery` runs again when its input changes and when the app's data changes, from this UI, another open UI, an agent, a schedule, a webhook, or a workflow. `data` stays on screen while a later run loads: show the old data quietly (the starter dims the list), not a spinner in its place.
- `mutate` resolves when the backend answers. Disable the control while it runs, say what it does ("Saving…"), keep what the user typed when it fails, and show the error's message. The queries run again by themselves after a write; do not refresh them by hand.
- For immediate feedback before the backend answers, pass `{ optimistic(cache) { ... } }` as the third argument to `api.mutate`. `cache` reads and updates mounted `useQuery` entries with `get(name, input)`, `set(name, input, value)`, `update(name, input, updater)`, and `updateAll(name, updater)` (all typed from `app.ts`). If the mutation fails, the optimistic updates roll back automatically; when it succeeds, they stay in place until `data-changed` refreshes and reconciles with the backend's answer.
- For a newly created row that needs an ID before the backend assigns one, use a temporary placeholder ID (such as `optimistic-${crypto.randomUUID()}`). Disable row actions that need the real ID (like opening or deleting the row) while the placeholder is pending, and let the `data-changed` refresh replace it with the server's row:

```tsx
const add = (text: string) =>
  api.mutate('add', { text }, {
    optimistic(cache) {
      const tempId = `optimistic-${crypto.randomUUID()}`
      cache.updateAll('list', (notes, input) => {
        if (!notes) return notes
        if (input.search && !text.toLowerCase().includes(input.search.toLowerCase())) return notes
        return [{ id: tempId, text, created_at: Date.now() }, ...notes]
      })
    },
  })
```

- Show a loading state, an empty state, and the error of a failed call with a way to try again.
- `api.useConfig()` gives the app's config, typed from `app.ts` ([config](config.md)).
- `storage`, `files`, `tools`, `models` (`useModelCall`, `models.watch`, `models.get`, `models.cancel`), `onDataChanged`, and `desktop` are also in `@solus/app` ([data](data.md), [files](files.md), [access](access.md), [models](models.md), [desktop](desktop.md)).

## The project

- The UI is React, TypeScript, and Tailwind v4, built into one page. `@/` resolves to `src/`. Keep `index.html` free of scripts and links, and keep its two `<!-- artifact:... -->` markers.
- Install only what the app needs, with exact versions, in the project. No CDN, no runtime JSX compiler, no code splitting, no worker, no `eval`.
- Import fonts, images, and other assets from source, so the build puts them in the page.
- Tailwind scans the source. Use complete class names, or a mapping from state to complete class names; a class name built from parts does not generate CSS.
- React escapes text. Do not use `dangerouslySetInnerHTML` for user data, documents, or code. Check the protocol of a link that comes from data.
- An app's page has no network but the hosts in `permissions.network`, over HTTPS. For a service that does not allow cross-origin requests, call it from an operation.

## The window

A visual in a reply is a document: it is as tall as its content and has no shell. An app is not. It gets a window of a fixed size and lays out everything inside it:

- On desktop and web the window is all of the pane the app opens in. On a phone it opens full screen.
- Fill it. Give the root `min-h-dvh` or `h-dvh`, and build the shell the app needs: a sidebar, a header, a toolbar, a footer that stays in place. Let the content region scroll (`overflow-auto`), or let the page scroll. `100vh` and `100dvh` are the window here.
- The window can be 360px wide or 1400px wide. Design both: a sidebar that becomes a top bar or a menu, a table that scrolls sideways, a row that stacks. Use container queries, wrapping layouts, and `min-w-0` on a flex child that holds text.
- The root is 16px, so a size in `rem` (every Tailwind size) is what it says: `h-8` is 32px and `text-sm` is 14px.
- Solus draws a thin bar above the window with the app's name, the App and Manage switch, its menu, and close. Do not draw a second window bar. Its Manage switch opens the app's Manage page: its versions, secrets, schedules, webhooks, signals, files, calls, and runs. The app cannot open it: where the app needs a secret, say which one to set there. Do not build a second admin screen for what the Manage page has.

## Pages

An app with more than one screen has pages. The whole UI is one built file, so the pages are routes inside it. The starter's `src/route.ts` does this:

- Keep the page in the address after `#`: `#/customers`, `#/customers/42`, `#/settings`. Read `location.hash`, listen for `hashchange`, and link with `<a href="#/customers/42">`. A link that starts with `#` stays in the app; any other link opens outside it.
- To move from code, assign the fragment: `location.hash = '#/customers/42'`. Do not use `location.assign`, `location.replace`, or `history.pushState` with an address: the page runs in a frame that has no address of its own, so they fail or load something else. For the same reason a routing library needs its in-memory router (`createMemoryRouter` in React Router), not its hash or browser router.
- Every page handles a reload: it loads what it shows with a query by what is in the address, not from state another page left in memory. The starter's note page does this with `get`.
- Give every page a way back, and show which page is open in the navigation.
