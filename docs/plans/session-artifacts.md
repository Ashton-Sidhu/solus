# Session artifacts: what a session produced

Status: implemented, 2026-10-28. Desktop, web, and mobile.

The **Artifacts** surface lists what a session produced or linked: pull
requests, works, files, images, and automations. For a session that started
other sessions (a lead), it also lists the artifacts of each session below it
in its delegation tree under that session's name, so a person never opens worker transcripts to find a pull
request. Nothing new is stored: the read joins records that already exist.

## Vocabulary

- **artifact** — one item a session produced or linked. Its kind is
  `pull-request`, `work`, `file`, `image`, `automation`, or `app` (an app the
  session deployed or linked; docs/plans/apps.md decision 18)
  (`packages/contracts/src/session-artifacts.ts`).
- **Artifacts surface** — the companion-pane surface that lists them, route
  `artifacts` (`docs/plans/companion-surfaces.md`). On mobile, the Artifacts
  screen reached from the thread's menu.
- **own** — the session's own artifacts. **children** — one group per session
  below it in its delegation tree: the sessions it started, oldest started
  first, then the ones they started, level by level.

Do not call the surface a tab, a panel, or a page.

## Decisions

1. **One read, four sources.** `readSessionArtifacts` in
   `packages/server/src/data/sessions/session-artifacts.ts` joins the session's
   pull requests (`session_pull_requests`), the works whose `sessionIds`
   include it (`works`), and its file and automation links (`session_links`,
   written by the `link` agent tool and the Solus API's `PUT /links`). A file
   whose extension is an image's is kind `image` (`isImagePath`). Each list is
   newest link first. Children are the records below the session through
   `parentSessionId`, at every depth, at most 200. A cycle ends the walk.
2. **The RPC is `sessionArtifactsList(sessionId)`**, `read` on the session
   resource, answered by the execution host. The host event
   `session.artifactsChanged { sessionId }` fires on every link or unlink of a
   pull request, work, file, or automation, and on a delegate's change for each
   ancestor too. Clients reload on it.
3. **The surface opens itself.** When the store sees the artifact count of the
   conversation on screen rise from an event-driven refresh, the `artifacts`
   surface is added to the strip if absent, made active, and the companion pane
   opens if it was hidden. Not on the initial load, not on a reload, and never
   when the count falls. The newest row is highlighted once. Closing the surface
   works like any other; the next link opens it again.
   When the newest link is an app, the app's own surface opens beside the
   conversation (docs/plans/apps.md §9), and the Artifacts surface joins the
   strip behind it and does not take its place.
4. **Manual entry points**, the same as Changes and Files: the + menu in the
   companion strip, the shortcut `opt+shift+e` (`conversation.open-artifacts`;
   on web `opt+shift+'`, because the browser client's organization switcher
   holds `opt+shift+e`), and the command palette ("Open artifacts", "Open
   artifacts in main pane"). The route's placement is `either`, so "Move to
   main" in the strip works for it too.
5. **A row opens its item as a surface** with the existing routes: pull request
   review, work, file (serverId, cwd, path), automation. Every item opens on
   the session's own connection: a link's `hostId` is the execution host's
   machine id, and the host refuses a file or automation on any other host.
6. **Read-only.** The surface lists and opens. Unlinking stays with the item's
   own surface and the agent tool.
7. **Mobile.** A phone has one pane, so a new link does not change the screen:
   the Artifacts entry in the thread menu carries the count and an unread mark
   until the person opens it (`apps/mobile/`).
8. **Session cards show chips.** A card for a session that another session
   started (`AgentConversationCard`; the phone's agent rows in
   `ThreadAgents.tsx`) shows what that session linked, as chips under its
   row, newest first. The caller's list holds a group for each session it
   started, so one read serves every card of a conversation; a session on
   another host, or one the caller did not start, is read on its own. One
   model draws the chips on every client
   (`packages/client-core/src/session-artifact-chips.ts`):
   - The tint is the type: teal for docs and slides, purple for
     artifacts, blue for files, rose for images, the Solus accent for
     automations, sky for apps. A pull request's chip is plain, and its icon takes the
     colour and glyph of its state, as `prStatusBadge` draws them.
   - Overflow: a card shows four chips, then `+N`, which opens the session's
     Artifacts surface. One item over the limit shows as a chip, not `+1`.
     The row wraps; a chip is at most 12rem wide and cuts its label.
   - A folded group's header shows one total per kind ("2 PRs", "3 works"),
     and hides them below a 40rem card width. A total opens the caller's
     Artifacts surface. An open group shows each row's chips instead.
   - The phone opens a pull request, file, or image from its chip. A work or
     automation has no screen there, so its chip opens the Artifacts screen.
9. **A finished turn shows what it linked.** Under the reply and the image
   gallery, a chip row lists the session's own items linked during that turn,
   with the same model and overflow as a card (`turnArtifacts`,
   `TurnArtifacts.svelte`, `TurnArtifactChips` on the phone). Nothing is stored:
   a link belongs to the turn that started at or before its `linkedAt` and before
   the next turn started, so the last turn also takes later links. A running
   turn shows no row, and a delegate's links stay on its card. An image the
   turn's gallery shows gets no chip, so it shows once.

## Verification

- Unit: the read joins the four sources, tags images, orders newest first, and
  groups children with their titles; the events fire on link and unlink
  (`session-artifacts`). The renderer's grouping and filtering helpers, the
  auto-open rule, and the keybinding manifest.
