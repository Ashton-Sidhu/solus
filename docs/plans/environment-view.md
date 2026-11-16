# Environment view: Browser, Devices, and Artifacts in one control

## Vocabulary

- **Environment view** — what a session's environment shows: `browser`, `devices`, or `artifacts`. `devices` opens the Devices pane on the session's simulators and phones, not on its Builds page. `artifacts` is the session's Artifacts surface (`docs/plans/session-artifacts.md`), not one work and not the works gallery.
- **View row** — the desktop and web control: a split row in the Environment card. The row opens the view; the caret lists all three.
- **Environment menu** — the phone control: a menu in the thread header with the same three items.

## Rule

One rule decides the view on every client: `environmentViewFor` in `packages/client-core/src/environment-view.ts`.

1. The user's choice for this session.
2. Else **Devices**, when the session shows a device preview now.
3. Else **Artifacts**, when the session's Artifacts surface lists at least one item: a pull request, work, file, image, or automation of the session or of a session below it in its delegation tree. The count is the surface's own list (`sessionArtifactsList`), so the row and the surface always agree. The tree is the canonical delegation record (`Session.parentSessionId`, set by `start_sessions`): the sessions this one started, the ones they started, and so on, as the sidebar nests a chain under its top session. It goes down only: a delegate counts its own delegates, never its parent or siblings. A `send_session` to a session this one did not start adds no edge.
4. Else **Browser**.

The rule returns null until the first read of the session's artifact list answers. A failed read counts as answered; the Artifacts surface shows the failure and its retry. The control shows "Checking session…" with a loading state. It does not show Browser first and then change to Artifacts.

Every item can always be chosen and opened. The control adds no empty or unavailable states: the pane that opens owns its own state.

## Not covered

- A child started on another host (`start_sessions` with `host`): its record and works are on that host, and this host keeps no delegation record for it.
- A session that received `send_session` but was not started by this one: it is not a delegate, and its other artifacts are not this session's.
- A start that failed before the child recorded its delegation.

## Choice

A choice is kept per host and session, for the life of the window. It is not persisted and not synced. Choosing a view opens it.

## Clients

- **Desktop and web** — `EnvironmentSection.svelte`. The count comes from `SessionArtifactsStore`, the store the Artifacts surface reads, so it follows `session.artifactsChanged`. Artifacts opens the session's Artifacts surface (`openArtifacts`). A draft has no session and no Artifacts surface, so the item opens nothing there. A guest without `host.use` cannot use the row, as with the Browser and Devices rows before it. Devices opens the Devices pane on the simulators (`openDevices`); Builds stays one click away in that pane and in the command palette.
- **Mobile** — `apps/mobile/src/features/threads/environment-view-menu.ts` and `use-environment-menu.tsx`, in the thread header. The count comes from the thread's `SessionArtifactsFeed`, the feed of the Artifacts screen. Artifacts opens that screen (`ThreadArtifacts`), Browser opens the browser viewer (`ThreadBrowserPreview`), and Devices opens the Devices screen (`Devices`).

## Approved platform exception (2026-10-28)

The phone reads no device previews, so a device does not make Devices its view; only a choice does. On the phone, all three items are enabled; choosing one records it as the session's view and opens its screen.
