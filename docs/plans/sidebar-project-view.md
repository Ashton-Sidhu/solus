# Sidebar project view

The session sidebar on desktop and web has two views. The person selects one
with the personal setting `sidebarView` (Settings → Appearance → Layout → Sidebar view, or
the `toggle-sidebar-view` palette entry). User behavior: `docs/session-lists.md`
("Sidebar views").

Reference: t3code PR 21039 ("boring sidebar") and PR 26391 (folders ordered by
the last prompt the person sent).

## Vocabulary

- **Status view** (`sidebarView: 'status'`, the default): the sidebar as it was
  before. The sessions, Shared with you, the Working section, and the Snoozed and
  Completed shelves.
- **Project view** (`sidebarView: 'project'`): one **project folder** per project
  for the person's open sessions, working or not, and their drafts. Shared with
  you, Snoozed, and Completed stay below. There is no Working section.
- **Project folder**: a group key (`SidebarTask.groupKey`) with its header
  (`SidebarFolderHeader`). Open or closed. Not "group", "section", or "bucket":
  a section is Shared with you, Working, Snoozed, or Completed.

## Decisions

1. **Two views, one list.** `SessionStatusView` and `SessionProjectView` each
   turn the same input (`SidebarListInput`) into `SidebarListItem[]`, and both
   hand the items to `SidebarList`, which draws the rows (`TaskRow`, unchanged),
   the section headers (`SidebarSectionHeader`), the motion, and the keyboard
   tree. `SessionSidebar` mounts only the view in force, so only that view's
   `$derived` runs.
2. **Grouping is one pass.** `buildProjectListItems`
   (`session/lib/sidebar-project-folders.ts`) groups the scoped rows and drafts
   by group key in one pass and sorts each folder. It reads no transcript.
   A draft leads its folder as a one-line row (`DraftRow` with `inFolder`), in
   the order the drafts were opened; the status view keeps drafts above the
   list. A folder exists for a project with only a draft. A closed folder
   counts its drafts and hides them: a draft needs nobody.
3. **Order in a folder.** By `max(createdAt, lastSentAt)`, newest first.
   `Session.lastSentAt` is renderer-local: `PromptDispatch` sets it when the
   person sends from a composer, and the tab snapshot keeps it across a reload.
   An agent reply, a wake, an automation prompt, and a prompt sent from another
   client do not set it on this client. A session with no conversation open
   here goes by when it started.
4. **Folder order** is the project filter's order
   (`SessionSidebarStore.projectFilterChoices`). A project the workspace cannot
   name comes last, under its rows' project label.
5. **Closed folders** are view state of one client: `SidebarFolderState` keeps
   the closed group keys in `localStorage`
   (`solus.sidebar.closed-project-folders`). A folder is open until closed.
   A closed folder still shows the row on screen, as a closed section does.
6. **Folder actions.** New session (on the header and in the right-click menu)
   opens a draft in the folder's checkout on that checkout's host, only when the
   project is available and the host lets the person start sessions. Chats start
   a chat. Copy path copies the checkout path. A "Project settings" entry is
   left out: the Projects settings page reads the host chosen on that page, not
   the folder's host, so it would open the wrong list for a remote project.
7. **No drag.** The Solus sidebar has no drag reorder in either view.
8. **Keyboard.** A folder header is a tree item (`data-folder-key`). → opens a
   closed folder, then moves to its first session. ← closes an open folder.
   ← from a session or a draft in a folder goes to the folder. ⌫ does nothing
   on a folder (`treeKeyIntent`).
9. **Started sessions.** In both views a row that started sessions and has
   no pull request names them on a chip after its title (`TaskRow`'s
   `startedSessionsChip`): a glyph and a count in the bare form of the task
   and pull request chips, full ink while open and receded while folded. The
   chip folds and unfolds them; a caret was tried and read as a folder
   control. A row with a pull request spends one chip on everything it links
   to: `PrChip` shows the leading pull request, a muted "+n", and a menu of
   the pull requests then the started sessions (selecting one opens it). The
   linked task has no chip on the row and is not in that menu: the tooltip
   names it, and the task page is reached from the row's context menu; → unfolds and
   ← folds by key, before ← climbs. The drawer follows the conversation on
   screen (`SessionSidebarStore.isNestedOpen`): open under the row on its path,
   closed under every other row. The caret and the keys set an override for one
   row that lasts until the conversation on screen changes; a click on the row
   opens the session and the drawer.
   The sessions sit behind a guide line under the title and show and hide at
   once: a sliding height lays out the column every frame during the
   conversation switch. The raised card is a pseudo-element plate shown by
   opacity, so nothing changes size. A selection eases plate, ink, and
   title weight on one 150ms clock; the sans fonts are variable, so weight
   can transition. The store hands the row
   every started session; the row keeps the session on screen visible while
   folded (`visibleNestedSessions`).

## Surfaces

- Desktop and web: both views, the setting, and the palette entry.
- **Mobile: approved exception.** The maintainers scoped this feature to desktop
  and web. The phone's thread list keeps its own layout. The setting syncs to the
  phone but the phone does not read it.
- Providers: not provider-specific.
