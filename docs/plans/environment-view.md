# Environment view: Browser, Builds, and Artifacts in one control

## Vocabulary

- **Environment view** — what a session's environment shows: `browser`, `builds`, or `artifacts`.
- **View row** — the desktop and web control: a split row in the Environment card. The row opens the view; the caret lists all three.
- **Environment menu** — the phone control: a menu in the thread header with the same three items.

## Rule

One rule decides the view on every client: `environmentViewFor` in `packages/client-core/src/environment-view.ts`.

1. The user's choice for this session.
2. Else **Builds**, when the session shows a device preview now.
3. Else **Artifacts**, when the session has an artifact work. The session's artifacts include those of the sessions it sent work to: a worker's report shows its artifacts in the sender's conversation. A worker owns its artifacts; the sender's view only counts the ones the reader can list.
4. Else **Browser**.

The rule returns null until the session's artifacts are known: on desktop and web, the works list and the host's list of the sessions this one sent work to; on the phone, the first transcript page and that list. The control shows "Checking session…" with a loading state. It does not show Browser first and then change to Artifacts.

Every item can always be chosen and opened. The control adds no empty or unavailable states: the pane that opens owns its own state.

## Choice

A choice is kept per host and session, for the life of the window. It is not persisted and not synced. Choosing a view opens it.

## Clients

- **Desktop and web** — `EnvironmentSection.svelte`. Artifacts come from `WorksStore` (works of type `artifact` linked to the session or to a session it sent work to; `DelegatedSessionsStore` reads those sessions with `sessionRecordList({ parentSessionId })`, and reads again when an artifact names a session it did not ask about); Artifacts opens the one changed last, or the works gallery (Folio) when the session has none. A guest without `host.use` cannot use the row, as with the Browser and Builds rows before it.
- **Mobile** — `apps/mobile/src/features/threads/environment-view-menu.ts` and `use-environment-menu.tsx`, in the thread header. The session's own artifacts come from the loaded transcript; those of the sessions it sent work to come from the host's works list, read when the thread opens and when a turn ends. Artifacts opens the session's newest own artifact full screen, else the newest one a worker made.

## Approved platform exception (2026-10-28)

The phone has no Solus browser pane, no device (Builds) pane, and no works gallery. The product owner approved this exception. On the phone, all three items are enabled; choosing one records it as the session's view. Only Artifacts opens a surface: the session's newest artifact, full screen. A phone browser view and a phone Builds view are separate work.
