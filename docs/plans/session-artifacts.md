# Session artifacts: what a session produced

Status: implemented, 2026-10-28. Desktop, web, and mobile. The session view
(decisions 10 to 16) is implemented on desktop and web, 2026-11-12; the phone
keeps the list of decisions 1 to 7 until its screen is built.

The **Threads** surface shows what happened in a session: a row of what it
made (pinned and latest first), its turns as a timeline, the files it changed, the agents it started, and what it produced or
linked (pull requests, works, files, images, and automations). For a session
that started other sessions (a lead), it also shows what each session below it
in its delegation tree linked, so a person never opens worker transcripts to
find a pull request. Nothing new is stored: the surface joins records that
already exist.

## Vocabulary

- **artifact** — one item a session produced or linked. Its kind is
  `pull-request`, `work`, `file`, `image`, `automation`, or `app` (an app the
  session deployed or linked; docs/plans/apps.md decision 19)
  (`packages/contracts/src/session-artifacts.ts`).
- **Threads surface** — the companion-pane surface that lists them, route
  `artifacts` (`docs/plans/companion-surfaces.md`). It was the Artifacts
  surface until 2026-11-13; the route id and the command ids keep the old
  name, so saved layouts and custom shortcuts still work. On mobile, the
  Threads screen reached from the thread's menu.
- **recent row** — the "Pinned and recent" section of pictures at the top of the surface: the
  session's works, apps, files, and images, pinned first, then the latest
  opened, changed, or added (decision 17).
- **own** — the session's own artifacts. **children** — one group per session
  below it in its delegation tree: the sessions it started, oldest started
  first, then the ones they started, level by level.

- **turn timeline** — the plot at the top of the surface: the session's tool
  calls over its working time, cut into turns. It is not the session timeline
  an agent reads with `read_session`, and not a pull request's activity
  timeline.
- **turn** — the stretch from one prompt to the next, as the conversation cuts
  it. A notice the agent SDK injects opens no turn.
- **scope** — what the cards show: the whole session, or one turn.
- **card** — one kind's rows under the turn timeline.

Do not call the surface a tab, a panel, or a page. Do not call a turn a step
or a message, and do not call the scope a filter.

## Decisions

> **2026-11-22:** decisions 10, 14, 15, and 16 are changed by
> `docs/plans/session-digests.md` (decisions 10 to 12): the surface reads the
> session tree, so it needs no open conversation; an agent filter scopes it;
> each kind of link has its own card; and the Agents card shows no chips.

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
3. **Automatic opening is optional, and off by default.** Chat settings holds
   the personal `autoOpenArtifacts` setting on every client. Desktop and web
   open the surface only when it is enabled. A new companion pane requests 30%
   of the workspace width; the person can resize it. When enabled and the store sees the artifact count of the
   conversation on screen rise from an event-driven refresh, the `artifacts`
   surface is added to the strip if absent, made active, and the companion pane
   opens if it was hidden. Not on the initial load, not on a reload, and never
   when the count falls. The newest row is highlighted once. Closing the surface
   works like any other; the next link opens it again when the setting is on.
   When the newest link is an app, the app's own surface opens beside the
   conversation (docs/plans/apps.md §9), and the Artifacts surface joins the
   strip behind it and does not take its place.
4. **Manual entry points**, the same as Changes and Files: the + menu in the
   companion strip, the shortcut `opt+shift+e` (`conversation.open-artifacts`;
   on web `opt+shift+'`, because the browser client's organization switcher
   holds `opt+shift+e`), and the command palette ("Open threads", "Open
   threads in main pane"). The route's placement is `either`, so "Move to
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
   turn's gallery shows gets no chip, so it shows once. The person chooses the
   size of these chips (Settings › Chat › Artifact chip size: small, medium, or
   large; medium by default, small is the card size). A card's chips stay small.
   A pull request linked during the turn that the turn's final reply (its
   last assistant message) mentions takes a card in that reply, not a chip
   (`placeReplyPullRequests` in `packages/client-core/src/reply-pull-requests.ts`).
   A mention is the pull request's URL, `owner/repo#N` or `repo#N`, or
   `PR #N` / `pull request #N`; a bare `#N` can be an issue, so it is not one.
   The card goes after the top-level block that mentions it, so it never cuts
   a sentence or a list. A block that is only the link becomes the card, or
   goes when the card is already above it. A
   mention only inside a code block, or a reply with reference links or
   footnotes (which splitting would cut from their targets), puts the card
   after the reply. A pull request the reply does not mention stays a chip.
   Desktop and web render each text part with the same markdown renderers
   (`turnReplyCards`, `ReplyPullRequestCard`); the phone does the same in
   `FinalReplyMarkdown`. The card itself (`pullRequestCard` in
   `pull-request-card.ts`; `PullRequestTurnCard` on each client) shows the
   state (glyph and type word), the title, `owner/repo #N · author · age`,
   and the size (files, additions, deletions) once PR sync pushed the full
   pull request. A newer link snapshot wins over an older full read for the
   state. A footer offers the session's watch (docs/plans/pr-watch.md): "Turn
   on" while a watch can start, "Turn off" while it runs. A merged, closed,
   or missing pull request offers none, and a reader without `edit` sees a
   running watch but no switch.
   Two or more cards with no text between them are one segment
   (`{ kind: 'pull-requests', links }`) and one group card
   (`ReplyPullRequestGroup`; `PullRequestGroupCard` on the phone). Its line
   counts the pull requests and their states in the order of a pull
   request's life, "3 pull requests · 1 open · 1 draft · 1 merged"
   (`pullRequestGroupSummary`). Folded, the rail totals the files, and only
   when the host counted every one. It opens unfolded, with one row per pull
   request: the state glyph, the title, the state word, `owner/repo #N`, and
   the size. The eye at the end of a row is that pull request's watch, the
   same switch as the single card's footer: an open eye while it runs, a
   crossed eye while a watch can start, and an empty slot for a merged or
   closed pull request. A reader without `edit` sees a running watch but no
   switch. Pull requests named in separate paragraphs keep a card each, under
   the words about them.

10. **The surface is the session, not only its links.** Under one head (the
    session's name, how it stands, its branch) it shows the recent row
    (decision 17), the turn timeline, and one card for each kind: Changes, Agents, Pull
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
12. **Selecting a turn scopes everything under the turn timeline.** The cards
    show only its rows. A link, an agent, or a
    checkpoint carries a time and no turn id, so it is in the turn whose prompt
    is the last one before it (the rule of decision 9). The scope names its
    turn by the prompt's message id, so it holds when earlier history loads.
    Selecting the turn again, Escape, or the clear control returns to the
    whole session. Left and right arrow keys step through the turns.
13. **There is no kind filter.** The four tiles that counted the scope and
    narrowed the cards to one kind were replaced by the recent row
    (2026-11-13). A card's label still folds it.
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
    project panel's Agents card lists them (`railAgentList`), grouped by how
    they stand: Working, Done, Failed, Stopped, and last Snoozed, which holds a
    started session the person snoozed, whatever its agent did, as the
    sidebar's Snoozed shelf does (`agentGroups`). A group's label folds it. A
    row shows a status glyph, the title, the provider, and how long the agent
    ran in the sidebar's clock style, and under it what the agent is on or came
    back with. A snoozed row shows when it wakes, and that pill wakes it now. What a
    started session linked hangs under its row as chips (the model of decision
    8; `+N` opens that session's Artifacts surface). A row opens the sub-agent
    or the session. A started session's row takes the sidebar's session menu
    on right-click, with the sidebar's row actions: Stop, Done, Snooze (the
    presets and the custom time, with an undo toast), and Archive. Snooze
    writes the person's session list, so the sidebar and the card agree. A
    sub-agent has no session and no menu.
16. **The transcript is read on the client, so it needs the conversation open.**
    The timeline, the agents, and the changed files show for a session that
    has a conversation in this workspace. For any other session (a started
    session opened from its card) the surface shows the linked artifacts and
    says why. When the conversation holds only its recent history, the timeline
    covers what is loaded, and a control in its caption loads the remainder. The transcript is
    scanned once for each appended message, and never for a streamed token.
17. **The recent row shows what a person comes back for.** At the top of the
    surface, under the head, a section of its own with no card around it,
    labelled "Pinned and recent"
    (not "Artifacts": it holds what was pinned or touched last, not every
    item), holds one row of the works,
    apps, files, and images of the session and the sessions it started; pull
    requests and automations stay in their cards. Pinned works come first;
    then each item by the latest of three times: when this device last opened
    it, when a work last changed (`updatedAt`), and when a session linked it.
    An item two sessions linked shows once. The row holds at most 12, scrolls
    sideways, and is the whole session's: a turn or a search does not narrow
    it. Its label folds it, as the cards' labels fold them, and its arrows
    page the row. Each item is a small picture over its name on one line, cut
    with an ellipsis, and a short age ("10m"): a written work shows its title
    and the start of its text (`preview`), an image shows itself, and an
    artifact, an app, or a file shows its icon. A pin
    marks a pinned work. One model orders the row on every client
    (`packages/client-core/src/recent-artifacts.ts`).
    - The read gives each work its `pinned`, `updatedAt`, and `preview`
      (optional: an older host leaves them out, and the row orders by the
      link time alone). A client reads the list again on every `works.changed`
      for a work the list holds, so a pin or an edit moves the row.
    - When an item was opened is kept on each device (`localStorage` on
      desktop and web, the app's key-value store on the phone), at most the
      newest 200 opens. Every open of a session's artifact on that device
      records it: the row, the cards, and the chips.
    - On the phone the row heads the Threads screen. A work has no screen
      there, so its picture only shows it.

## Verification

- Unit: the read joins the four sources, tags images, orders newest first, and
  groups children with their titles; the events fire on link and unlink
  (`session-artifacts`). The renderer's row text and search helpers, the
  auto-open rule, and the keybinding manifest.
- Unit: the timeline picks the finest span that fits, keeps a wait to one bar,
  and counts each call in its turn's bar (`turn-timeline`). The scope puts a
  link, an agent, and a checkpoint in one turn; changes order by size and keep
  unknown counts unknown; the transcript scan cuts turns where the
  conversation does (`session-overview`).
- Unit: the recent row puts pinned works first, then the latest of opened,
  changed, or linked; leaves out pull requests and automations; shows an item
  two sessions linked once; and the open log survives a restart, reads a
  damaged store as empty, and keeps the newest 200 (`recent-artifacts`). The
  read returns a work's pin, last change, and preview (`session-artifacts`).
