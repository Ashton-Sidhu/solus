# Background activity notifications

Solus counts new questions, approval requests, failures, and completions received while the client is in the background. The badge counts each host/session once. Desktop shows an application badge. Web and mobile use the browser Badging API when supported and a count favicon while the page is running.

Returning focus clears the client activity count. This does not answer a question, approve a request, or remove durable server attention state. When attention resolves, its session leaves the count. Removing a host removes its count. Initial and reconnect snapshots establish a baseline without replaying old notifications.

Settings → General → Background activity toasts enables an optional toast for another session while the client is focused. The default is off. Each toast offers Open session, which includes the source host in its route and restores input focus. Both Editor and Pill use the same notification store. Claude and Codex use normalized attention entries.

These indicators are independent of the existing notification and sound setting. Native notifications retain their existing actionable-event policy; completions are added only to the activity badge and opt-in toast path.

Badges are client shell state. Electron uses a typed local preload method; remote hosts do not control device APIs. Each desktop renderer clears its local count when either Solus window receives focus. Browser support for installed application badges varies. The favicon provides the running-page fallback; the page does not promise background execution after the browser suspends or closes it.

The native implementation targets the shipped macOS desktop app. It does not add a Windows taskbar overlay. Browser indicators remain available on Windows through the web client.
