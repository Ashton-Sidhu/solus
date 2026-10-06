# Companion surfaces: tabs in the companion pane

Status: implemented, 2026-10-05. Desktop and web. See "Implementation notes" for
where the code differs from the first draft of this plan.

The companion pane holds a strip of **surfaces**, and the user moves between them
like tabs. Each destination in the leading pane has its own strip. Overlays go
away from the model.

The reference is t3code's right panel (`apps/web/src/rightPanelStore.ts`,
`components/RightPanelTabs.tsx`). In t3code, a page is a destination you
navigate to, and a panel tab is a thing you inspect next to it. The PR list is
a page. One PR is a panel tab. Solus uses the same rule.

## Problem

A `PaneEntry` holds one `base` and one `overlay` (`routing/location.ts`). When
you open a second thing in the companion pane, it replaces the first. The
overlay is a second, hidden way to stack content. From the task page, a click
on the task's session replaces the task. The `page` and `artifact` exclusive
groups replace content in a different pane, which surprises the user.

## Vocabulary

- **destination** — the route in the leading pane: a conversation or a page.
  You navigate to a destination.
- **surface** — one route in the companion pane's strip. You inspect a surface
  next to the destination. Do not call it a "tab": in Solus a tab is the UI
  state of a session (`TabRegistry`).
- **strip** — the ordered surfaces of one destination, the active surface, and
  whether the companion pane is open.
- **active surface** — the surface the companion pane shows.
- **source surface** — the surface from which the user opened a new surface.

Do not coin "panel tab", "side tab", "aside tab" or "secondary tab". The
**leading pane** and **companion pane** keep their meaning.

## Decisions

1. **Destinations and surfaces are different route kinds.** `Placement` becomes
   `'destination' | 'surface' | 'either'`. It replaces `'any' | 'aside' |
   'overlay'`.

   | Placement | Routes |
   |---|---|
   | destination | `tasks`, `prs`, `reviewMode`, `settings`, `folio`, `automations`, `notifications` |
   | surface | `task`, `prReview`, `prDiff`, `plan`, `work`, `automation`, `goal`, `review`, `files`, `subagent`, `browser`, `devices` |
   | either | `chat`, `draft`, `sessionRecord`, `insights` |

   `task` and `prReview` leave the page group. `plan`, `work` and `automation`
   no longer take the leading pane. The `task-conversation` layout (lead
   conversation in the leading pane, task beside it) is already this model.

2. **Remove the exclusive groups.** `ExclusiveGroup`, `isPageRoute` and
   `isArtifactRoute` go away. Their only job was to keep one item per pane. A
   destination always replaces the leading pane. Surfaces use the open rules
   below.

3. **Remove overlays.** `review`, `files` and `subagent` become ordinary
   surfaces. `PaneEntry.overlay`, `closeOverlay`, `visibleRef`, the overlay
   separator in the codec and `pane-actions.closeOverlay` go away.

4. **Each destination has its own strip.** When the leading destination
   changes, the companion pane shows the strip of the new destination. When you
   come back, the strip is as you left it.
   - A conversation's strip is keyed by its session (`chat/<sessionId>~<serverId>`).
   - A draft's strip is keyed by its draft id. When the draft becomes a
     session, the strip moves to the session key.
   - A page's strip is keyed by the route name (`tasks`, `prs`, ...). It
     lives only for the current run and is not saved. t3code does the same with
     its PR page strip.
   - When a tab closes or a session is deleted, its strip is deleted.

5. **The leading pane always holds one destination.** It never holds a strip.
   We keep the pane list and pane ids, because geometry, focus,
   `CompanionPanes` animation and `pane.maximize` attach to them. The list
   always has one leading pane and at most one companion pane. The code that
   prepared for more panes is deleted (see "What to delete").

6. **`settings` stays a destination.** It keeps `returnsOnClose`. It is not
   shown full-window as in t3code.

7. **No compatibility code.** We delete the old implementation. We do not keep
   shims for old URLs, old saved locations or old route names. An old saved
   location that the new codec cannot read falls back to the default location,
   as any bad input does now.

8. **Wide surfaces use the existing maximize.** `pane.maximize` (`opt+M`)
   fills the workspace with the companion pane. The leading pane stays mounted
   under it. We do not add a second maximize.

9. **Mobile is an explicit platform exception.** A strip does not fit a phone.
   The native auxiliary column (`apps/mobile/src/features/layout/
   AdaptiveWorkspaceLayout.tsx`) keeps one item. Desktop and web get strips.
   Mobile web uses the same workspace UI, so it gets the strip too.

## Model

```ts
export interface PaneEntry {
  id: PaneId
  /** Left to right. The leading pane holds exactly one: its destination. */
  surfaces: RouteRef[]
  activeSurfaceIndex: number
  defaultSize?: number
}

/** The strip a destination owns while another destination is on screen. */
export interface StoredStrip {
  surfaces: RouteRef[]
  activeSurfaceIndex: number
  isOpen: boolean
}
```

- `Location` stays the description of what is on screen. The companion pane in
  `location.panes[1]` is the strip of the current destination.
- `RouterStore` keeps `strips: SvelteMap<string, StoredStrip>` for the
  destinations that are not on screen. A destination change saves the current
  companion pane into the map and restores the strip of the new destination.
  Mutate the pane in place, as `location.ts` does now. Do not rebuild the
  `Location`.
- **Closing vs hiding.** Closing the last surface deletes the strip. Hiding the
  companion pane (`pane.close`, `Escape`) keeps the strip with `isOpen:
  false`. A command reopens it. This is the reverse state of hiding.
- **Surface identity.** Each route descriptor gets `surfaceKey(params)`. It
  names the subject and leaves out the detail. Examples: `files` is `cwd` +
  `path` (not `line`), `review` is the source session (not `view`, `scope` or
  `filePath`), `task` is `taskId`. The default is `serialize`.
- **Following routes.** `devices` without `sessionId` and `browser` without
  `browserPageId` follow the focused conversation today. In a strip, the opener
  fills in the destination's session, so a surface always names its subject.
  `review.sourceTabId` names a tab. A review surface in a conversation strip
  resolves its tab from the strip's session.

## Open rules

`place()` applies these rules. Callers such as `openBrowser`, `openPlan`,
`openTasks` and `showDiff` do not decide where a route goes.

1. **A destination opens in the leading pane.** The strip of the old
   destination is saved.
2. **A surface opens in the strip of the current destination.** If the
   companion pane is closed, it opens with that one surface.
3. **No duplicates.** If a surface with the same `surfaceKey` is in the strip,
   it becomes active and its detail params are updated (line, view, scope).
   If the subject is the leading destination, focus moves to the leading pane.
4. **A different subject opens a new surface.** A click inside a surface opens
   the new surface immediately to the right of its source surface. An open
   from the leading pane adds the surface to the right of the active surface.
   The new surface becomes active.
5. **The same subject updates in place.** A task section, a review view, a
   different line in the same file, and a navigation inside a browser page do
   not add a surface.
6. **A session is the one route with two placements.**
   - From the session sidebar, the command palette or a keybinding, it opens as
     the destination.
   - From inside a page or a surface (a task, a PR, an insights row), it opens
     as a surface. Example: tasks page → task surface → its session opens as a
     surface to the right of the task.
   - `mod+click` on a session row opens it as a surface.
   - "Move to main" makes a chat surface the destination. It replaces
     `promoteSplitToMainTab`.
7. **`mod+click` opens a surface in the background.** The active surface does
   not change.
8. **Opens the user did not start do not take the active surface.** This covers
   an agent that opens the browser or devices, and an automatic diff. If the
   user acted on the strip after the opener read the strip's revision, the
   surface opens in the background with an unread dot. If the companion pane is
   closed or empty, the surface opens and becomes active. This is t3code's
   `openProactive`.
9. **Closing a surface.** The surface to its right becomes active, or the one
   to its left if there is none. When the last surface closes, the companion
   pane closes and the strip is deleted. Focus returns to the input bar when
   the leading destination is a conversation.
10. **No limit on the number of surfaces.** The strip scrolls sideways. There is
    no drag reorder in this plan.

## Mounting

- Only the active surface is mounted, with one exception: routes with
  `keepAlive` stay mounted and hidden with `display: none`.
- `chat` is already `keepAlive` through `ConversationPool`. A chat surface uses
  the pool, so an inactive chat surface counts toward the pool's three recent
  conversations.
- The browser's native webview layer must hide the webview of an inactive
  browser surface. Check this in `components/browser/` before phase 4.
- All other surfaces keep their state in stores (`tasks`, `prs`, `works`,
  `plan`, `git-status`), so they can unmount.

## URL and persistence

- The codec keeps its grammar. The leading pane is the path. The companion
  pane is one `p`, and its surfaces are joined with `!`. A new `a` gives the
  active surface index. `f` stays the focused pane.

  ```text
  /tasks?p=task/T1!chat/S2~h1&a=1&f=1
  ```

- The URL carries only the strip on screen. `PersistedTabs`
  (`solus-open-tabs`) saves the location and the strips of conversations.
  Page strips are not saved.
- Back and forward restore the whole location, including the companion strip.
  `applyLocation` matches surfaces by `surfaceKey`, so a surface that did not
  change keeps its mounted component.

## Keyboard

The tab keys act on the pane that has focus. VS Code editor groups work the
same way.

- With focus in the companion pane, `global.next-tab` and `global.prev-tab`
  (`ctrl+Tab`, web `opt+shift+→`) move between surfaces.
  `global.close-tab` (`mod+shift+W`, web `opt+shift+W`) closes the active
  surface. With focus in the leading pane, these keys act on session tabs, as
  now.
- `Escape` (`pane.close`) hides the companion pane and keeps the strip.
- Middle-click closes a surface. The context menu has Close, Close others,
  Close to the right and Move to main.
- Every surface in the strip is reachable with `Tab` and the arrow keys.

## What to delete

Delete each item in the phase that replaces it. Do not leave an unused export,
a forwarding wrapper or a compatibility branch. Line numbers are from
2026-10-05.

**Routing model** (`contexts/workspace/routing/`)

- `location.ts`:
  - `PaneEntry.base`, `PaneEntry.overlay` and `visibleRef`.
  - `closeOverlay` and `dropPane`.
  - `movePane`. It is replaced by `moveSurfaceToMain`.
  - `findPane`, `refFor` and `isRouteOpen`. Replace them with one strip lookup
    by `surfaceKey`.
  - The N-pane code: `NavTarget` (`'aside' | 'new' | PaneId`),
    `appendOrReuseTrailing`, `asidePane`, `resolveTargetPane`, and the
    `MAX_PANES` comment about raising the cap. A route's placement now decides
    the pane.
- `route-registry.ts`:
  - `Placement` values `'any' | 'aside' | 'overlay'`.
  - `ExclusiveGroup`, `exclusiveGroup` on every descriptor, `isPageRoute`,
    `isArtifactRoute` and `isMovableRoute`.
  - `RENAMED_ROUTES` and the legacy `review` parse branch (around line 466).
    Decision 7 says we keep no shims for old links.
- `codec.ts`:
  - `OVERLAY_SEPARATOR` and the base/overlay split in `serializePane` and
    `parsePane`.
  - The special case that drops a companion pane whose only base is a chat
    with no session. A chat surface must name its session, so `parse` rejects
    it like any other bad surface.
- `router.store.svelte.ts`:
  - `closeOverlay`, `overlayPaneId`, `movePane` and the leading-pane move
    helper.
  - The overlay branch of the route-close helper (around line 234).
  - `asidePanes`. It becomes one `companionPane` getter.

**Workspace commands** (`contexts/workspace/workspace.context.svelte.ts`)

- `showViewer`, and the overlay toggling in `toggleDiff`, `showDiff`,
  `openFiles`, `openFileInFiles` and `openSubagent`. Each one becomes a plain
  surface open.
- `openTabInSplit`, `openSplitChat`, `closeSplitChat` and
  `promoteSplitToMainTab`. They become a chat surface open, `closeSurface` and
  `moveSurfaceToMain`. Update the callers in `session-opening.ts`,
  `surface-context.svelte.ts`, `SessionSidebar.svelte`,
  `SessionContextMenu.svelte`, `ConversationPane.svelte`,
  `AgentConversationCard.svelte`, `TaskPage.svelte`, `WorkspacePage.svelte`
  and `PageComposer.svelte`.
- The `secondary` option of `openPlanModal` and `openWorkModal`, and the
  `'leading' | 'secondary'` target of the task opener (around line 1943). The
  route's placement decides. Update the callers in `PlanMessageItem.svelte`,
  `editor/reference-navigation.ts`, `unified-picker/lib/picker-linked-actions.ts`,
  `TaskPage.svelte` and `WorkspacePage.svelte`.
- The `target: 'aside'` and `target: 'new'` arguments in navigate calls (about
  27 call sites). Only `background` stays as an option.
- The `openInSplit` callbacks in `HtmlBlock.svelte`, `DocumentStackCard.svelte`
  and `agent-conversation/lib/agent-conversation.ts`. They become a surface
  open.

**Components**

- `components/ui/lib/pane-actions.svelte.ts`: `closeOverlay` and `movePane`.
- `components/ui/Pane.svelte`: the overlay close control and the
  `exclusiveGroup` check.
- The overlay close buttons in `ReviewPane.svelte`, `FilesTreePane.svelte` and
  `SubagentHostPane.svelte`. The close control on the surface strip replaces
  them.
- `components/layout/WorkspaceBody.svelte` and `WorkspaceLayout.svelte`: the
  overlay rendering, the split-chat close and promote buttons, and the
  `isMovableRoute` move control.
- `components/layout/lib/workspace-body.ts`: the `isPageRoute` and
  `isArtifactRoute` branches.
- `SessionDraftPane.svelte`: its `movePane` call.
- `.overlay` reads in `SubagentsSection.svelte`, `SubagentLink.svelte`,
  `DiffSummaryCard.svelte`, `presence.store.svelte.ts`,
  `work-review-commands.ts` and `apps/client/src/GuestApp.svelte`. Read the
  active surface instead.

**Tests**

- Delete the cases that test overlays, exclusive groups, N-pane moves and old
  link names in `routing-location`, `routing-codec`, `routing-router`,
  `pane-route-lifecycle`, `workspace-visibility`, `workspace-ui-lifecycle` and
  `work-pane-opening`. Replace them with cases for the open rules. Do not keep
  a test for behavior that no longer exists.

Before you finish each phase, search again for the symbols removed in that phase.
Search only in `packages/workspace-ui/src`, `apps/client/src`,
`apps/desktop/src` and `tests/unit`. The search must find no matches.

## Phases

Each phase keeps the app working. Phases 1 and 2 land together, because the
model change removes the `overlay` and `base` fields that the phase 2 callers
read.

1. **Model and codec.** Replace `base`/`overlay` with `surfaces` in
   `location.ts`. Change `place()`, `closePane` and `applyLocation`. Add
   `closeSurface` and `moveSurfaceToMain`. Change the codec. Tests:
   `routing-location`, `routing-codec`, `routing-router`, `pane-close`.
2. **Placement.** Change `Placement`, remove the exclusive groups and overlays,
   and add `surfaceKey`. Update `showViewer`, `toggleDiff`, `openFiles`,
   `openSubagent`, `openSplitChat`, `promoteSplitToMainTab`, `pane-actions`
   and the `returnsOnClose` path. Tests: `work-pane-opening`,
   `pr-detail-panel-target`, `pane-route-lifecycle`.
3. **Strip for each destination.** Add `strips` to `RouterStore`, swap them on
   a destination change, persist them, delete them when a tab closes, and move
   a draft's strip to its session. Tests: a new
   `tests/unit/companion-strips.test.ts`, `session-bootstrap-location`.
4. **Strip UI.** Add `components/layout/CompanionSurfaceStrip.svelte`, based on
   `tasks/task-page/TaskTabStrip.svelte`. Add the context menu, middle-click,
   the keyboard rules, `keepAlive` mounting and focus return. Light and dark
   mode. Use `text-workspace-chrome` and 16px icons. Tests:
   `secondary-pane-keybindings`.
5. **Background opens.** Add the strip revision and the unread dot for opens
   the user did not start. Opens from agents (browser, devices) and the
   automatic diff use this path.

## Docs to update

- `docs/browser-routing.md`: the `p`, `a` and `f` parameters.
- `packages/workspace-ui/CLAUDE.md`: remove `OverlayContent` and `closeOverlay`
  from the naming examples, and add the destination and surface terms.
- The header comment in `routing/location.ts` and the `Placement` comment in
  `route-registry.ts`.

## Surfaces checked

- **Clients:** desktop and web share this work. Mobile is the exception in
  decision 9.
- **Providers:** none. This is renderer routing only.
- **Contracts:** none. No RPC or event topic changes.
- **Connection modes:** a surface keeps its `serverId`, so strips with
  surfaces from two hosts work. A strip whose host is not connected shows the
  existing per-route disconnected states.
- **Reverse states:** open and close a surface, hide and reopen the companion
  pane, maximize and restore, make a chat surface the destination and open it
  as a surface again.

## Implementation notes

The code follows this plan, with these differences:

- **`draft` is `either`.** The new-split-chat key opens a draft as a surface,
  and Send turns it into a chat surface in the same place (`inPlace`).
- **The empty pool has a strip key.** With no tab, the pool's strip is keyed
  `pool`, so hiding and showing the companion pane works before the first
  session.
- **Browser and Devices are one surface each.** Their `surfaceKey` is fixed.
  The browser surface has its own page strip; Devices was single-instance
  before.
- **Hidden strip.** `Escape` hides the companion pane. The existing
  `global.open-in-split` key (`opt+shift+\`) shows it again. No new binding.
- **The strip always shows** when the companion pane is open, also with one
  surface, as in t3code.
- **Rule 8 is simpler.** An automatic open (an agent opens the browser or a
  device) goes to the background when the companion pane shows a different
  surface. There is no user-action revision.
- **Persisted strips are a list**, each entry with its `destinationKey`, under
  `PersistedTabs.strips`.

### Still to do

- The "Open in split" secondary actions on work, plan and automation cards,
  embeds and the Workspace page now do the same thing as a plain click. They
  can go: `PlanMessageItem`, `AutomationRefCard`, `ArtifactActivityCard`,
  `ArtifactRail`, `DocumentStackCard`, `ArtifactEmbedNodeView`,
  `DiagramEmbedNodeView`, `WorkspaceItemContextMenu`, `WorkspaceRow`,
  `WorkspacePage`, `HtmlBlock`. The session variants (`SessionContextMenu`,
  `TaskSessionsList`, `AgentConversationCard`) still mean something.

