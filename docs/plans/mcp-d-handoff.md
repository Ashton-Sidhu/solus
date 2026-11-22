# MCP phase D handoff: MCP servers that run on the host

Branch: `solus/discover-running-local-mcp-servers`, from `main` at
`5bb58455a` (the worktree started at `759729497`, an ancestor of `main`, and
was fast-forwarded to `main` before any change). Nothing was pushed. No pull
request was opened.

Commits:

- `a97224dbe` feat(mcp): find MCP servers that run on the host's loopback (phase D)
- the docs commit that adds this file, the as-built notes of
  `mcp-first-class.md` (§1 items 40–46, §9.5), and `docs/integrations.md`.

## Note, 2026-11-20: TCP listeners of a Solus process are checked now

Branch `solus/2feaa060`. The gap in "What the feature does not give that D
needed" is closed by the maintainer's decision: `LocalMcpServers` also sends
`server/discover` to a loopback TCP row (`response: null`) whose `startedBy`
is `agent` or `terminal`, once the list has shown it for 2 seconds. One
`POST /mcp` for each process and port, kept for the life of the process,
with the limits above. An agent's MCP server now shows under Found on this
host and raises the session card with no Server URL. The rule is in
`mcp-first-class.md` §9.6. The running-servers feature did not change;
`local-servers.ts` and its test changed. A listener of a process that Solus
did not start still gets nothing: the person pastes its `http://localhost`
address in Settings → MCP.

Tests: 8 new in `tests/unit/integrations/local-servers.test.ts` (fake
registry and fake probe, and a small loopback MCP server and a non-HTTP TCP
server owned by the test): one request in a life of 20 scans, none before
the 2-second wait, a terminal's listener checked and another process's and a
LAN address's not, a listener that goes before the wait waits again, "not
MCP" kept and a new process checked again, no second check after a Server
URL answer, the found row and the agent's card, no `setTimeout` or
`setInterval` from the owner, and a real non-HTTP service gets one connection
only. Each guard was removed once to see its test fail.
`bun test tests/unit/integrations/` 409 pass, 0 fail; `running-servers-*`
40 pass. `tsc` of `packages/server`: 134 messages before and after, the same
by message; no other package changed. `oxlint` on the two files: clean. No UI
text changed, so no screenshots. Not run: a real agent turn, Electron,
mobile, Linux, Windows.

## What was built

### Host

- `packages/server/src/integrations/local-servers.ts` (`LocalMcpServers`). It
  follows the running-servers registry through `observeScans` and adds no timer
  or watcher. `boot-server.ts` makes it beside `FoundServers` and calls
  `follow(serverRegistry)` once the registry exists.
- Found on this host: `FoundServers.list` merges the running MCP servers with
  the file servers (a file entry with the same local address gains the port
  place; any other is its own row) and returns `portScan`. `FoundServers.add`
  falls back to a running server by `foundId` and adds it through
  `createIntegration`, the probe and record of a typed loopback URL. A process
  that ended or another answer gives `found-changed`.
- Not running: the `integrationFacts` handler sets `reachable` for an
  integration whose URL is on the loopback. When nothing listens on its port, a
  failed list does not fail the facts read. A port that has a listener again,
  or another listed process on it, calls `gateway.invalidate` (drops the
  sessions and the lists) and sends `integration.changed` with
  `change: 'facts'`, so the next run lists the tools.
- A refused call to a loopback integration answers "`<name>` is not running on
  `<host display name>`. Start it, then try again." (`callFailureText` in
  `gateway.ts`; the session-open error now keeps its `cause`).
- §9.4: `runtime-instructions.ts` gives a run that has `connect_integration`
  the sentence of §9.4. (An MCP endpoint of an agent's process raised the card
  by itself at first; that was removed, see §9.4.)
- `IntegrationStore.listAnyOwner(scope)`: every record, whoever owns it, so a
  listener that comes back changes each integration on its port.

### Contracts

- New `packages/contracts/src/integrations/local-servers.ts`:
  `FoundPortPlace`, `FoundPortScan`, `IntegrationReachable`,
  `loopbackServerPort`. It is apart from `integration-types.ts` so the first
  screen does not carry it.
- `integration-types.ts`: `IntegrationFacts.reachable?`,
  `FoundServer.foundIn: Array<FoundPlace | FoundPortPlace>`,
  `FoundServerList.portScan?`, and `isLoopbackHostname` exported. No new RPC
  method or event: the existing found list and the facts event carry it.
- `found-server-labels.ts`: `foundPlacesText` takes a port place and the host
  label; `portPlaceText`, `foundPortOf`, `portIdentityText`,
  `NOT_RUNNING_LABEL`, `notRunningText`, `portScanUnavailableText`; the empty
  text names running servers too.

### Desktop and web (shared Svelte)

- `SettingsTabMcp.svelte` reads the host's running-servers store while the page
  is open. That holds the lease (§9.1), and a change of the list reads Found on
  this host again. The section text names running servers; an `unavailable`
  scan shows its reason beside the file problems.
- `McpFoundRow.svelte`: the port row has the same markup as a file row, the
  places line "Port 8931 on `<host>` · node · notes-mcp", and the line "It
  says it is Notes 0.4.0. Solus did not verify this: any program on this host
  can answer on a port."
- `McpFoundDialog.svelte`: the same dialog shell (no outline border), with the
  identity warning and "Solus checks the address again before it adds it."
- `McpServerRow.svelte`: "Not running" in the neutral row-status color; the
  open row says "`<name>` is not running on `<host>`. Start it, and its tools
  show here." in place of the tools, and does not load tools while it is down.
- `integrations.store.svelte.ts`: a loopback server's facts load with the list
  and on its facts event, like a command's; a facts answer that says `running`
  clears an old tools error, so an open row lists the tools again.

### Mobile

- `use-command-processes.ts` holds the running-servers lease while the MCP
  screen is mounted and reads the facts of loopback servers too
  (`isNotRunning`).
- `use-found-servers.ts` reads the found list again on a change of the
  running-servers store, and keeps `portScan`.
- `FoundServersSection.tsx`: the port row shows its places and identity note;
  the native alert has the identity line; an `unavailable` scan shows its
  reason.
- `IntegrationsScreen.tsx` and `integrations.ts`: the installed row says "Not
  running"; the open row shows the reason in place of the tools
  (`InstalledTools`).

## The exact requests a listener can get, and when

- Only an endpoint of the newest running-servers list whose
  `response.protocol` is `http` (today: a Server URL from `.solus/config.json`
  that answered the registry's own `GET`), and whose `address` is `127.0.0.1`
  or `::1`. The request goes to that address, never to the URL's host name.
- Path `/`: `POST /mcp`; then `POST /` only when the registry's `GET` answer
  was not `text/html`. Another path: one `POST` to that path (and query).
- The request: `POST`, `content-type: application/json`,
  `accept: application/json, text/event-stream`, `mcp-method: server/discover`,
  body `{"jsonrpc":"2.0","id":0,"method":"server/discover","params":{"_meta":{…protocolVersion 2026-07-28, clientCapabilities {}, clientInfo solus}}}`.
  No credential (`credentials: 'omit'`, no Authorization, no cookie),
  `redirect: 'manual'`, 1.5 seconds, at most 16 KB read; an event stream is
  read until its first event.
- MCP when: a JSON-RPC result or error (any status), an event stream, or a 401
  whose `WWW-Authenticate` names `resource_metadata`. The first MCP answer
  ends the requests of that endpoint.
- No `initialize` follows. A server of revision 2025 answers `server/discover`
  with a JSON-RPC error, which is already MCP; an `initialize` would open a
  session on a server the person did not choose. The add's probe
  (`probe.ts`) sends `initialize` to such a server after the person's Add.
- At most four requests at one time on the host.
- When: on each registry scan (only while a client holds a running-servers
  lease, which Settings → MCP does while open), and on a read of Found on this
  host (which asks for one list when the last is older than 10 seconds).
- The answer, "not MCP" and a timeout too, is kept for (process, endpoint)
  until the port has no listener or another listed process holds it. So one
  endpoint of one process gets at most two requests in its life.

## Running-servers feature: each line changed

`packages/server/src/host/running-servers/discovery.ts` (+5):

- a private field `ports` (the loopback and wildcard ports of the last scan,
  any owner) and its doc line;
- in `discover`, `this.ports = new Set(listeners.map((listener) => listener.port))`
  after the listeners are read;
- `listeningPorts(): ReadonlySet<number> { return this.ports }`.

`packages/server/src/host/running-servers/registry.ts` (+18, −1):

- the exported type `RunningServerScan` (a scan, or a failed scan);
- `RunningServerRegistryDeps.discovery` also takes an optional `listeningPorts`;
- a private `scanObservers` set; `observeScans(observer)` and `observed(scan)`;
- in `list`, after `this.servers = servers`, one call `this.observed({ at,
  servers, listeningPorts })` (with the endpoint ports as a fallback when a
  fake discovery has no `listeningPorts`);
- in `tick`'s catch, one call `this.observed({ at, error })`;
- in `initRunningServers`, `listeningPorts: () => discovery.listeningPorts()`.

No contract, client, or behavior of the running-servers feature changed. Its
tests pass (registry 9, client 10, http 9, forward 3, stop 7).

### What the feature does not give that D needed

- **An HTTP fact for discovered listeners.** Automatic discovery sends no
  probe, so a server that an agent or a terminal started is a TCP row
  (`response: null`). The brief allows a request only to a listener the
  registry knows as HTTP, so D finds such a server only when its address is a
  Server URL. To find it without that, the registry would need its own HTTP
  fact for an owned listener (the old scanner's `GET /`), or the maintainer's
  consent to send `server/discover` to a TCP row of a process Solus started.
  §9.4 has the same limit; the runtime sentence covers it.
- **A host-side reader and the unowned ports.** The registry published only to
  clients and dropped the listeners it does not own. D added `observeScans`
  and `listeningPorts` (above), the smallest change that gives an honest Not
  running for a server started outside Solus.
- **The Running servers card's Add to MCP** (§9.2) was not built: the card's
  client code (`client-core/running-servers/`, the mobile screen) is being
  rewritten in the main checkout now.

## Contradictions between the plan and the code

Recorded in `mcp-first-class.md` §1 items 40–46 and §9.5, in the docs commit:

1. Discovery sends no probe; "the scanner's `GET /`" is the `GET` of a Server
   URL (item 40, corrects item 16).
2. The list holds only Solus-started processes and Server URLs, so §9.3's rule
   would lie; D reads every listening port of the scan (item 41).
3. The registry had no host reader (item 42).
4. "One POST for one process" against §9.1's two requests: D follows §9.1
   (item 43).
5. §9.1's retry of a timeout after 30 seconds: not built; the brief's "one
   time for each process and port" wins (item 44).
6. §9.2 leaves an added server out of the list; D shows it as Added (item 45).
7. There was no `connect_integration` block in `runtime-instructions.ts`; the
   sentence is its own entry block (item 46).

Also: `FoundPlace` keeps its name for the file place; the port place is
`FoundPortPlace`, and `foundIn` holds both (§8.2 wrote one union named
`FoundPlace`). The port place carries `processName`, `checkout`, and
`serverInfo`, which §8.2 did not list, because §9.2 and the brief ask the row
to show them.

## Screenshots

`/Users/sidhu/solus-screenshots/mcp/13-running-local-servers/`, 2× scale,
from the web demo of `apps/client` served by Vite from this worktree (PID
53729, stopped by that PID) with a temporary config (root `apps/client`, the
`.git/` deny rule relaxed) and temporary demo data in
`apps/client/src/demo/handlers/integrations.ts`. The demo file was copied back
from a backup and the config removed; nothing temporary was committed. Dark
captures set the classes `applyTheme(true)` sets.

- `/Users/sidhu/solus-screenshots/mcp/13-running-local-servers/light-01-found-on-this-host.png`, `dark-01-found-on-this-host.png`: a command from `~/.claude.json`, two running servers (one that said its name, one that did not), and a loopback server from Cursor's file shown as Added.
- `light-02-add-dialog.png`, `dark-02-add-dialog.png`: the add dialog of a running server, no outline border.
- `light-03-not-running.png`, `dark-03-not-running.png`: Installed, the Weather row (`localhost:8787`) says Not running.
- `light-04-not-running-open.png`, `dark-04-not-running-open.png`: the same row open: the reason in place of the tools.
- `light-05-running-again.png`, `dark-05-running-again.png`: after it runs again: the row lists its tools.

Each was looked at. Mobile was not captured: it needs a native build.

## Tests and checks

- New `tests/unit/integrations/local-servers.test.ts`, 25 tests, fake
  registry and fake probe, and small loopback servers owned by the test (no
  port scan): the allowed requests in a listener's life over 20 scans; HTML
  gets no `POST /`; a path gets one request; a TCP-only listener and a
  non-loopback address get none (and `fetch` is never called for one); a new
  process is checked again; four at a time; a legacy JSON-RPC error counts and
  no `initialize` follows, with no credential; an event stream that stays open;
  the 401 rule; a redirect is not followed; the suggestion adds nothing; Added
  under `localhost`; the add goes through the probe and `createIntegration`,
  and another answer or an ended process adds nothing; an unavailable scan;
  Not running is derived and never written; a server that starts again is
  listed again by the real gateway (`modernToolLists` 1 → 2); another process
  on the port drops the list; a refused call gives the text; the runtime sentence.
- `bun test tests/unit/integrations/`: 386 pass, 0 fail.
  `runtime-instructions` 24/0, `running-servers-*` 38/0,
  `integrations-store` 24/0, `integrations-store-commands` 9/0,
  `native-mobile-integrations` 51/1 (the known label of `main`).
- `startup-import-graph`: the two budget cases fail as on `main`. First
  screen: web 4,871,957 bytes, desktop 4,987,383, which is +195 bytes each over
  this branch's base (the three fields and one type import in
  `integration-types.ts`); the new types and labels are not on it.
- `tsc --noEmit`, compared by message with `main` before the change: server
  134 → 134, workspace-ui 40 → 40, client-core 2 → 2, contracts 0 → 0, mobile
  0 → 0; `apps/client` 78 (the count `main` had). No new message.
  `svelte-check` on workspace-ui: 312 errors and 18 warnings (as on `main`),
  none in a changed file.
- `oxlint` on the changed files: the only messages are the two complexity
  errors that `main` has (`InstalledRow` 22, `callAs` 36); D added none.
- `lint:surfaces` clean. `lint:layout`: the known `RunOnPicker.svelte` and
  `EditorVoiceControl.svelte` failures; none in a changed file.

## Not done or not verified

- **Discovered (TCP) listeners are not checked** (above): an agent's or a
  terminal's MCP server is found only through a Server URL. A decision for the
  maintainer. *Done 2026-11-20: see the note at the top.*
- **Running servers card: Add to MCP** (§9.2) not built, on desktop, web, or
  mobile; `docs/running-servers.md` not changed for the same reason.
- **Mobile was not run**: no native build. Its changes pass `tsc` and the unit
  tests only.
- **Desktop (Electron) was not run**; the web demo shows the same Svelte, with
  a fake host. No real listener was found by a real host, and no real agent's
  server raised a real card.
- **No real provider turn ran.** The runtime sentence is tested as text only.
- **Without a lease nothing scans.** A server restarted while no client
  watches the host keeps its old tool list until its own expiry or a failed
  call; the plan accepts this.
- **macOS `lsof` shows only the Solus user's processes**, so a server run by
  another OS user (for example with `sudo`) shows Not running. Windows and
  Linux use their own listener reads; neither was exercised.
- **A shared host**: the agent's card is not raised when any person's
  integration already has the address; a member then adds it in Settings. The
  found list shows port servers to every person with `host.use`, as the
  running-servers list does.
- Codex and Claude both get the sentence and the card; neither was exercised
  with a real run.
