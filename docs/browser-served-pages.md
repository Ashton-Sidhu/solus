# Browser pages that close with their dev server

An agent often starts a dev server, opens it in the browser, and then stops the
server. Solus closes that page when the server does not come back, so the agent
does not leave a dead tab.

## The rule

The host links a page to a server when all of these are true:

- An agent opened the page with `browser_open`. A page that the user opened is never linked.
- The page address is a loopback address (`localhost`, `127.0.0.1`, `[::1]`, or `0.0.0.0`).
- A running server on that port has the attribution "started by an agent" of the same session
  (the `SOLUS_SESSION_ID` tag, `docs/running-servers.md`).

The host checks the linked server process every 3 seconds. When the process is gone, the
host waits 15 seconds (`SERVER_RETURN_GRACE_MS`) and then scans the running servers again:

- A server of the same session listens on the port again: the link moves to the new process, and the page stays. The page reloads by itself when the server answers (the liveness check in `browser-registry.ts`).
- No such server: the page closes with the usual close, and every client removes the tab.
- An agent is working in the page: the close is refused, and the host asks again at the next check.

The link ends without a close when the page closes, or when it shows another site. An error
page or a blank page during a failed load does not end the link.

## Limits

- The link is in host memory only (`packages/server/src/browser/served-pages.ts`). After a host restart, no page is linked.
- A server that takes more than 15 seconds to listen again after a restart loses its page.
- A process ID that the system gives again within one 3-second interval hides the stop.
