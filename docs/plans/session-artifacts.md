# Session artifacts: what a session produced

Status: implemented, 2026-10-28. Desktop, web, and mobile. The session view
(decisions 10 to 16) is implemented on desktop and web, 2026-11-12; the phone
keeps the list of decisions 1 to 7 until its screen is built.

The **Artifacts** surface shows what happened in a session: its turns as a
timeline, the files it changed, the agents it started, and what it produced or
linked (pull requests, works, files, images, and automations). For a session
that started other sessions (a lead), it also shows what each session below it
in its delegation tree linked, so a person never opens worker transcripts to
find a pull request. Nothing new is stored: the surface joins records that
already exist.

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

- **turn timeline** — the plot at the top of the surface: the session's tool
  calls over its working time, cut into turns. It is not the session timeline
  an agent reads with `read_session`, and not a pull request's activity
  timeline.
- **turn** — the stretch from one prompt to the next, as the conversation cuts
  it. A notice the agent SDK injects opens no turn.
- **scope** — what the surface shows: the whole session, or one turn.
- **tile** — one of the scope's four numbers: changed files, agents, pull
  requests, and works and files. A tile is also the kind filter.
- **card** — one kind's rows under the tiles.

Do not call the surface a tab, a panel, or a page. Do not call a turn a step
or a message, and do not call the scope a filter: the kind is the filter.

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

10. **The surface is the session, not only its links.** Under one head (the
    session's name, how it stands, its branch) it shows a scope card (the
    timeline, then the tiles) and one card for each kind: Changes, Agents, Pull
    requests, and Works and files. A card's label closes it. On a pane of
    44rem or wider the cards take two columns, so a row is never wider than a
    narrow pane. One model orders and scopes the rows on every client
    (`packages/client-core/src/session-overview.ts`).
11. **The turn timeline is working time, and a divider starts each turn.**
    Each bar is one round span (15 seconds to an hour; the finest whose bars
    fit the pane), as tall as the tool calls that started in it; a span with
    none is a dot, so the line runs on. A bar is full height at the count that
    19 bars in 20 stay under, and never under 10 calls: one burst does not
    press the other bars flat, and a quiet session is not a row of full bars.
    A divider stands where each turn starts and runs down beside the turn's
    start time, so a turn reads as one column. The times are short: the half
    of the day shows on the first label and where it changes, and a turn on a
    later day than the one before it names its day. The caption names the span
    in words, and pointing at a bar reads out its time and its count in the
    same place. A turn takes the bars its work took. The wait before the next
    prompt is one dot, however long it was, because a session left for a night
    would otherwise be one empty line. A wait of an hour or more is a break:
    it takes a few dots, and the line says how long it was (`3h`, `2d`). When
    the bars do not fit at the coarsest span, the plot scrolls and starts at
    its end (`packages/client-core/src/turn-timeline.ts`).
12. **Selecting a turn scopes everything under the turn timeline.** The tiles count
    the turn and the cards show only its rows. A link, an agent, or a
    checkpoint carries a time and no turn id, so it is in the turn whose prompt
    is the last one before it (the rule of decision 9). The scope names its
    turn by the prompt's message id, so it holds when earlier history loads.
    Selecting the turn again, Escape, or the clear control returns to the
    whole session. Left and right arrow keys step through the turns.
13. **The tiles count the scope, not the search.** A search looks for a row; it
    does not change how much the turn did. A tile's marks say how its rows
    stand (running, done, failed; open, draft, merged).
14. **Changes are the session's own, from git.** The whole session reads
    `diffStats` with scope `session`; a turn reads the checkpoint written in it
    (`listTurnSnapshots`, then `diffStats` with scope `turn`). Until git
    answers, and for a turn with no checkpoint, the rows are the paths the
    transcript names, with no counts: unknown reads as unknown, never as zero.
    The rows are the directory tree the conversation's changed-files card
    draws (`buildDiffSummaryTree`). A change of eight files or fewer, and a
    search, show the files at once; a larger change opens on its folders. A
    file row opens that file's diff in the review surface. Over the tree, a
    change of more than one kind (Code, Tests, Mocks, Generated, Docs: the
    kinds the review surface filters by, `changedFileKind`) shows a thin line
    with each kind's part of the changed lines, and a chip for each kind.
    Selecting a chip shows only that kind in the tree; the card's count and
    totals stay those of the whole change.
15. **Agents are the session's sub-agents and the sessions it started**, as the
    project panel's Agents card lists them (`railAgentList`). A started
    session's row shows counts of what it linked. A row opens the sub-agent or
    the session.
16. **The transcript is read on the client, so it needs the conversation open.**
    The timeline, the agents, and the changed files show for a session that
    has a conversation in this workspace. For any other session (a started
    session opened from its card) the surface shows the linked artifacts and
    says why. When the conversation holds only its recent history, the timeline
    covers what is loaded, and a control in its caption loads the remainder. The transcript is
    scanned once for each appended message, and never for a streamed token.

## Verification

- Unit: the read joins the four sources, tags images, orders newest first, and
  groups children with their titles; the events fire on link and unlink
  (`session-artifacts`). The renderer's row text and search helpers, the
  auto-open rule, and the keybinding manifest.
- Unit: the timeline picks the finest span that fits, keeps a wait to one bar,
  and counts each call in its turn's bar (`turn-timeline`). The scope puts a
  link, an agent, and a checkpoint in one turn; changes order by size and keep
  unknown counts unknown; the transcript scan cuts turns where the
  conversation does; the tiles count each kind (`session-overview`).
