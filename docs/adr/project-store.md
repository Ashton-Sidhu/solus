# One project store for all clients

Project state belongs to `projectsStore` in
`packages/workspace-ui/src/contexts/projects/projects.store.svelte.ts`.
It owns saved client history, host project metadata, and recent projects.
The server connection store owns connections and no longer caches recent projects.

Every host cache uses the server ID as its key. The header project chip, Open
project dialog, and directory picker read the same reactive recent-project list.
Concurrent loads for a host share one request. A successful response is cached for
30 seconds. Forced refreshes and explicit project opens reject older replies.
A failed refresh keeps the last known list and permits another request.

Page project switchers read saved history from this same store and can merge it
with projects supplied by their feature. Recent-project loads also update saved
history. History keeps the existing `solus-project-catalog` storage key and format.
Removing a history entry still removes only client history; passive discovery
cannot restore it, but an explicit open can. Files and host records are unchanged.
Host project metadata remains a separate projection because Settings uses the
host's project manifest, while recent pickers use its opening history.

The shared workspace UI uses this store on desktop, web, and mobile, in both
Editor and Pill modes. Host loads use the transport-neutral connection API,
including temporary connections to remote hosts. No provider contract changes.
