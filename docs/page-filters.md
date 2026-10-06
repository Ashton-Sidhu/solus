# Page filters

Workspace, Automations, and Tasks group controls that change which records are shown under a Filters button. The button shows an active tint and a count when its label is hidden. Search, sort, layout, and create actions stay on the page row.

- Workspace groups project, type, time, Pinned, and Needs my review. It is global: it opens on all projects, and its Project filter is local to the page, so it never changes the scope of Tasks, Pull requests, or Automations. Plans stay with their sessions.
- Automations groups Starred and status. Status remains a single choice, including Archived.
- Tasks groups Running, Overdue, Assigned, and status. Inbox project and involvement controls also appear in Filters. Board view omits status because its columns show every status.

The row uses the Pull Requests toolbar sizing: 32 px search and buttons, 40 px on narrow panes. Sort precedes Filters. Filter choices use dropdown submenus.

These controls use shared UI across desktop, web, and mobile. They keep the existing filter state and data loading behavior.

The session sidebar uses its saved project filter. Changing the active session or draft does not change its scope, including when there are no active task rows. A saved project that is no longer in the sidebar catalog falls back to All projects. The mobile session list shows active tasks across projects; its Snoozed and Completed shelves use the shared sidebar filter.
