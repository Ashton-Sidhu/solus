# Startup read ownership

Reads follow explicit lifecycle changes. A UI effect can declare which surface
is visible, but rendering or changing unrelated session state must not start
another request for the same data.

| Data | Owner and trigger |
|---|---|
| Host information | `ServerConnections.serverInfoFor`: one shared read per connection, including pending requests. Disconnect or transport replacement clears it. Settings can explicitly refresh it. Socket wake probes still reach the server. |
| Project identities | `ServerConnections.projectIdentities`: concurrent readers share one request. Completed results retain the existing cache lifetime; disconnect clears them. |
| Notification count | `NotificationHubClient`: startup, notification change, reconnect, foreground, or explicit refresh. |
| Notification history | The same client, only while a page is visible. Desktop/web pane visibility and native navigation focus register and release history readers. |
| PR interest | `PrsStore`: a changed combined interest set, or reconnect. Repeated component registration does not resend an unchanged set. Releasing the last surface sends an empty set. |
| Git state | `SessionEnvironmentStore`: startup reads after defaults are known, and normal consumers share pending reads. A pending details scan can satisfy a summary reader. Explicit refresh after a mutation still asks for fresh state. |

Connection reads are scoped to one host. A late result from a disconnected
connection must not fill the next connection's cache. Notification identity
changes clear all rows, and late history reads after page closure are discarded.

Focused tests: `server-connections`, `notification-hub-client`,
`native-mobile-notifications`, `prs-store-sync`, and
`git-environment-registration` under `tests/unit/`.
