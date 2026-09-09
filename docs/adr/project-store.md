# One project store for all clients

Project state belongs to `projectsStore` in
`packages/workspace-ui/src/contexts/projects/projects.store.svelte.ts`.
It owns saved client history, host project metadata, and recent projects.
The server connection store owns connections and no longer caches recent projects.

Every host cache uses the server ID as its key. The Open project dialog and
directory picker read the same reactive recent-project list.
Concurrent loads for a host share one request. A successful response is cached for
30 seconds. Forced refreshes and explicit project opens reject older replies.
A failed refresh keeps the last known list and permits another request.

Page project switchers read saved history from this same store and can merge it
with projects supplied by their feature. Recent-project loads also update saved
history. The header project chip reads this catalog filtered to the project host
selected by its run configuration. It merges in the current local checkout,
removes duplicates, and sorts by label with the shared `mergeProjectOptions`
function. All entries are searchable; there is no three-project limit. The chip
and its rows use `ProjectFavicon` with an explicit host ID, including the shared
folder fallback. Opening the menu still refreshes that host's recent projects to
update the catalog. Each project row has a keyboard-accessible remove action. The header and page
switchers share `ProjectRowAction`: one fixed slot at the far right shows the
selected checkmark at rest, then replaces it with a trash button on row hover or
keyboard focus. Touch clients keep removal visible. Page switchers retain their
history-only removal rule. Both pickers use the shared menu row spacing.
Removal hides the entry and the current-checkout fallback across menu opens and
refreshes, without changing the chat destination or deleting files. Opening the
project again restores its history entry. Focus returns to the menu search after
removal. History keeps the existing `solus-project-catalog` storage key and format.
Removing a history entry still removes only client history; passive discovery
cannot restore it, but an explicit open can. Files and host records are unchanged.
Host project metadata remains a separate projection because Settings uses the
host's project manifest, while recent pickers use its opening history.

The shared workspace UI uses this store on desktop, web, and mobile, in both
Editor and Pill modes. Host loads use the transport-neutral connection API,
including temporary connections to remote hosts. No provider contract changes.
