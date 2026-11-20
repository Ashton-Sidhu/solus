# Host fleet: one map of every machine, one host page, one way to add

Status: built for desktop and web on `solus/host-fleet`, 2026-11-13. Mobile follows (D10).

Mockup: the Solus work "Hosts fleet mockup" (`2fc8211f-8b2d-4802-a88c-000f2c5d77d6`).
Where this text and the mockup differ, this text wins.

## Problem

Host management is in about ten places: Settings → Hosts, Settings → Host
(Advanced), Settings → Organization (which sends people to the website),
onboarding, `ConnectHostPage`, `AddServerModal`, `HostOnboarding`, `RunOnPicker`,
and two web screens before a host connects. The host list (`HostDirectory`) shows
one status word for each host. It shows no load, no sessions, no route, and it has
no bulk action. A cloud machine can be created only in onboarding, and it cannot be
stopped or resized from the app. The easiest way to add your own machine (the
install command with a link code) shows only in cloud onboarding.

## Goal

Settings → Hosts becomes the place where a person sees, finds, adds, and manages
every machine their agents can run on: personal machines, SSH and WSL machines,
Solus Cloud machines, and machines an organization shares with them.

## Vocabulary

| Term | Meaning |
|---|---|
| **fleet view** | Settings → Hosts. It has two views: **Map** (default) and **List**. |
| **map** | The picture of how this device reaches each host. |
| **zone** | One region of the map for whose machine a host is: Your machines (whatever the route: local network, Tailscale, the tunnel, or an SSH or WSL forward), Solus Cloud, and Shared with you. Inside a zone, cloud machines group by organization and shared hosts by owner. |
| **route** | How this device reaches a host. This is the existing `HostRoute` (`docs/plans/host-routes.md`); the map draws it, it does not add a new concept. |
| **tile** | One small square for one host, used when a zone has more hosts than cards fit. |
| **found machine** | A machine that a Discover source sees and that the person has not added. |
| **Discover** | The scan that finds machines, and its control on the map. The found machines show on the map and in Nearby on the Add page; the fleet view has no Discover section. |
| **host page** | The one page for one host, the same for every kind of host. |
| **state icon** | The icon that shows a host's state. The word is in its tooltip and accessible name, not on the page. |

Use these words. Do not say "fleet manager", "machine page", "cloud host page",
"node", or "nearby list".

## Decisions

### D1. The fleet view stays in Settings → Hosts

It replaces `HostDirectory` in place (product decision, 2026-11-13). The tab keeps
its update badge. The internal tab id `api-access` does not change in this work.

### D2. A host is a host

Every host has the same page: header, the four numbers (CPU, memory, sessions,
latency), the six existing tabs, and on Overview: Running here, Machine,
Readiness, Danger zone. Only the actions a host supports change:

| Host | Header actions | Danger zone |
|---|---|---|
| Solus Cloud | Start, or Restart and Stop; New session | Delete (ends the machine and its disk) |
| This device | New session | none |
| Your machines, SSH, WSL | New session | Forget |
| Shared by an organization | New session | Remove from your hosts |

The Machine section (Solus version and update, Reachable with Test, Address) and
the Readiness section are the same for every host.

A cloud machine's size is fixed when it is made: `PATCH /v1/hosts/:hostId/spec`
changes only its packages and setup script, so the host page offers no Resize.
No RPC restarts Solus on a host, so a host you own has no Restart.

The existing tab components (`HostDetailResources`, `HostDetailAccess`,
`HostDetailGit`, `HostDetailProviders`, `HostDetailEnvironment`) keep their
content. `HostDetailOverview` is replaced.

### D3. Look: Solus tokens, white surfaces, state as icons

- Surfaces are white (`--card`), with `RowCard` borders and inset hairlines. The map
  canvas is white with a faint dot grid.
- Color uses the status tokens of `workspace.css` and nothing new. A healthy machine
  is the success green. Running work is terracotta (`--solus-status-running`).
  A warning is amber, and an error is the error red. Structure is washes and hairlines.
- A host's mark is its operating system logo (`HostOperatingSystemIcon`: Apple,
  Linux, Windows), on the map, in Discover, in Nearby, and on the host page. A WSL
  distro shows the Linux logo. A host whose system is unknown shows the icon of its
  route.
- State is an icon with a tooltip, never a word and never a dot: running (with the
  session count), idle, online, reconnecting, unreachable, stopped, update, sign in.
- Section headings, pill tabs, and chips follow `SettingsSection` and the settings
  chip strip.

### D4. The map

- This device is at the center, with a zone for each kind of owner around it.
  Links go from this device to each host, or to the Solus tunnel and then to the
  cloud and organization zones.
- Your machines is on the left of this device. Solus Cloud and Shared with you
  stack on the right, past the tunnel. An SSH or WSL host is one of your
  machines, not a zone of its own (product decision, 2026-11-13): its dashed
  link and its mark say how this device reaches it. A zone is as tall as its
  rows, and each stack is centered on this device. A zone and this device take a
  share of a narrow map and no more than a fixed width of a wide one, so a wider
  map gives its room to the links (`mapLayout` in `fleet/lib/fleet-model.ts`).
- The fleet view takes the wide measure of Settings (`max-w-6xl`), not the
  reading column, because it is a map and not a column of rows.
- A zone is a white panel with a hairline border, the same surface as the map.
- A zone with room always shows a row: its hosts, then a found machine (D7) or a
  way to add a host as a dashed outline, or "No shared hosts". Terracotta shows
  only running work; a found machine and this device are neutral.
- A link ends in a port on the edge of its card. A link carries no label: a card
  shows the latency of its host, and a full zone shows its median latency beside
  its counts. The legend below the map names the tunnel.
- A link is green when connected, amber and dotted when retrying, red and dotted
  when lost, and a faint dashed hairline when stopped. SSH links are dashed.
- A zone shows a card for each host while the cards fit (`cardCapacity` of the
  zone). Past that, it shows one tile for each host, grouped by region or pool,
  and one link for the whole zone. The link's width follows its sessions, and it
  turns amber when more than 10% of the zone is down.
- A full zone opens in place to fill the map. Each group shows its tiles and its
  totals, with bulk actions (Start, Retry, Update) for the zone.
- Tiles are colored by Status, CPU, or Sessions. Search fades the hosts that do not
  match.
- The area below the map has a fixed height. It shows the route and numbers of the
  host under the pointer, or the legend. Pointing never moves the page.
- Below 600px of container width, the map becomes a tree of the same routes.
- Up to about 1,000 hosts, tiles are DOM elements. Past that, they must move to a
  canvas. This is not in this work.

### D5. Motion: an approved exception for the map

The CLAUDE.md rule "avoid perpetual animation" has one exception, approved on
2026-11-13, for the map only:

- One terracotta light travels along each link that carries sessions. A trip takes
  3.5 to 8 s; busier links are faster.
- A retrying link crawls slowly (4 s).
- A scan sweeps once (2.4 s).

All three run only while the map is on screen (`IntersectionObserver`) and the
window is visible. They pause when the person pauses the map with the live
control, which is an icon: a broadcast mark in green while live, a pause mark
while paused, with the word in its tooltip (D3). The
reduced-motion setting turns them off. Number changes animate once (0.7 to 1 s).
There is no other continuous motion.

### D6. Data: existing endpoints, no new metrics endpoint

- **Presence** for every host comes from what the client already has: saved hosts,
  the account directory (`GET /v1/hosts`), and `host-readiness`.
- **Load** comes from each host's `hostResources()` through `HostResourceWatch`.
  The fleet view holds one watch for each connected host only while the map is on
  screen, and sampling is staggered.
- **Latency** is the round-trip time of that same `hostResources()` call.
- **Sessions** for each host come from the session lists the client already caches.
- A host that only the directory lists (for example an organization pool this
  device has not paired with) shows presence only, with no load.
- Many hosts means many connections. A cloud summary endpoint waits until we
  measure a real problem.

### D7. Discover: four sources

| Source | State | Where |
|---|---|---|
| Local network (UDP 34117) | exists | `transport/lan-discovery.ts` |
| WSL distros of this client's Windows host | exists | `add-wsl-distro.store` |
| SSH config | new | `hostsListSshConfigHosts` lists the machines `~/.ssh/config` names (`sshConfigHostCandidates` in `remote-machines/ssh-targets.ts`), without patterns and git hosts. |
| Tailscale peers | exists | `discoverServers` already probes the tailnet peers (`discoverTailnetServers` in `transport/endpoints.ts`) and returns them with `source: 'tailnet'`. The fleet view only names the source. |

Both sources were approved on 2026-11-13. The SSH config answer carries only names
and addresses, and only the host owner may read it, because the answer crosses the
network to web and mobile clients.

The map is where the fleet view shows found machines; there is no Discover
section below it (product decision, 2026-11-13). A found machine shows on the map
as a dashed card in the zone where it would go. Pointing at it shows its address
and how to add it in the area below the map. Clicking it opens the
Add page, where Nearby lists every found machine with its own action. A zone that
has more found machines than rows shows "+N found" in its header, and a full zone
shows "N found"; both open the Add page. In a narrow pane, the tree shows one
"N found nearby" row that does the same.

The scan control is beside the live control in the map header: a radar icon with
the count of found machines. It scans again, and it pulses while a scan runs.
Solus also scans again while the page is open (the existing 30 s scan while the
window has focus).

### D8. Add a machine: one page, Nearby first, then one choice

"Add machine" opens one page in two parts.

**Nearby** is always at the top. It lists the found machines of D7, each with its
OS logo, its address, and its own action, which finishes in its row: "Connect"
opens a field for the 6-digit code that the machine shows, and "Set up" on a WSL
distro installs Solus there. With no found machine, Nearby says so and offers
Scan again. A machine in reach never needs a choice first.

**Other ways** is one list. The person chooses one, and it opens in place:

1. **Create a cloud machine.** Name, region, size, and an optional setup script.
2. **Pair with a code.** An address or a pair link, and the 6-digit code. A pasted
   pair link fills both.
3. **Add over SSH.** The only way that opens its own form (`AddOverSshForm`,
   unchanged).

No way is marked as recommended. Nothing in Other ways opens before the person
chooses, except when a link from the map names a way. The chosen way opens with
its first field focused, so the next step is typing.

Linking a machine to a Solus Cloud account is not a way to add it: adding a host
needs no account. Registration and "Reachable from the internet" are on the
host's Access tab.

This page replaces the tabs of `AddServerModal`. `ConnectHostPage`, `RunOnPicker`'s
"pair a new host", the map, and the command palette open this page.

### D9. Cloud lifecycle: expose what solus-cloud already has

`solus-cloud/src/lib/server/managed/managed-hosts.ts` already has
`stopManagedHost`, `restartManagedHost`, `updateManagedHostSpec`, and
`deleteManagedHost`. Only the website calls them. This work adds `/v1` routes with
the account session:

| Route | Calls |
|---|---|
| `POST /v1/hosts/:hostId/stop` | `stopManagedHost` |
| `POST /v1/hosts/:hostId/restart` | `restartManagedHost` |
| `PATCH /v1/hosts/:hostId/spec` | `updateManagedHostSpec` (packages and setup script; the size is fixed) |
| `DELETE /v1/hosts/:hostId/machine` | `deleteManagedHost` |

`DELETE /v1/hosts/:hostId` (`deleteHost`) only ends a registration. It does not
remove a cloud machine. "Delete" on a cloud host page calls the machine route;
"Forget" on any other host keeps today's behavior.

Every account source (web at the account origin, desktop through the native
bridge) gets create, stop, restart, spec change, machine delete, and the account
read. The renderer reaches them through one store, `managedHostsStore`
(`contexts/connections/managed-hosts.store.svelte.ts`).

### D10. Mobile follows in a second change

Desktop and web share the Svelte UI and ship first. The mobile fleet screens
(`apps/mobile/src/features/hosts/`) follow in a second change with the same
capability. This is a product decision of 2026-11-13, not an omission.

### D11. Entry points

- The web command palette gets "Add host" and "Find hosts nearby", which today only
  the desktop palette has.
- Both palettes and the keybindings `global.add-server` and `global.find-hosts`
  run the same commands (`components/fleet/fleet-commands.ts`): "Add machine"
  opens the Add page, "Find hosts nearby" opens the fleet and scans. The
  keybindings keep no default key.

### D12. A session about a host, and the host chip

"Ask an agent" starts a session about a host: why it is offline, an update, a
sign-in, or a check of its health (product decision, 2026-11-13).

- It opens a new chat with a prompt ready to read and send, as "Set up with an
  agent" does (`openChatDraft`). Solus does not send it for the person.
- The prompt asks for the most urgent problem of the host: unreachable,
  reconnecting, a sign-in, an update, stopped, or a check when the host has no
  problem. A diagnosis asks the agent to report before it changes anything
  (`fleet/lib/host-agent.ts`).
- The session runs on the host itself when that host answers, so the agent reads
  its logs and updates it in place. A host that does not answer cannot run a
  session, so the session runs on this device, and on a client with no device
  host the Run on host decides. The prompt says which of the two it is.
- Entry points: the context menu of a host on the map (a card, a tile, this
  device, and a row of the narrow tree), and each row of "Needs attention",
  where one session covers all the hosts of the row. The row for a connection
  that drops again and again has no other action. The host page has no button
  for it (product decision, 2026-11-14).
- The context menu of a host also has Open host, New session, and the one fix
  its state has: Retry, Start, or Update. It opens with the secondary click and
  with the menu key on a host that has the focus.
- Saved remote hosts also have Remove in this menu, including when unreachable.
  Remove hides the host and shows the standard Undo toast. The existing host
  removal command runs only when the Undo period ends. Undo restores the row;
  a failed removal restores it too. Toasts stay inside Settings' focus boundary
  while its modal is open, so their actions work with a pointer and keyboard.
  This boundary fills the viewport; the Settings card is inside it. Toasts keep
  their normal viewport position, outside the card's transform and clipping.
  The host keeps its sessions and can be added again. This device has no Remove;
  managed cloud machines keep Delete on the host page because it deletes the disk.
- The agent gets no new tools in this work: it uses the shell of the host it
  runs on.

**The host chip.** The prompt names each host as a host chip, a reference token
like a task or a session (`contracts/src/host-link.ts`):

    [studio-mini](host://ref?serverId=h1&route=Tailscale&system=linux&address=…&state=unreachable)

- `serverId` is the identity: the host's installation id, which every client
  of the host knows and which an agent tool takes as `host` (`start_sessions`).
  A client resolves it to its own id for the host
  (`serverConnections.resolveId`). A host that has not said who it is uses this
  client's id. The other fields are what the client knew when the chip was
  made. The agent reads them from the link with no lookup, so the prompt has no
  list of facts. The state says whether the host answers ("online"), not how
  many sessions it runs.
- A person adds a chip from the `#` menu: Hosts is a category there
  (`#hosts/`), in the composer and in the document editor. Each row shows how
  this client reaches the host and whether it answers.
- The composer, a sent message, and an agent's reply all draw the link as a
  chip. In a message, a host of this client shows the name and the mark this
  client has for it now (its system logo, or the cloud), and opens the host's
  page. A host that is not one of this client's shows the name in the link,
  says "Not one of your hosts" in its tooltip, and opens nothing. The composer
  draws the name in the link with a server mark.
- An agent that names the host in its reply copies the link.
- Markdown that other people write (a pull request body) cannot make a host
  chip: `remoteMarkdownSanitizeUrl` does not let `host://` through.
- At send, the client adds a note for the agent after the typed text, one
  block for each host the prompt names (`hostReferenceContext`), as it does for
  a referenced session. The note says that the person means this Solus host,
  whether it is the host the session runs on, and how to start work on it
  (`host` of `start_sessions`). The person does not see the note: a transcript
  reader removes it (`stripInjectedContext`). Desktop, web, and mobile add it;
  mobile does not know the run host's identity, so its note says both cases.
- A copy of a message keeps a chip as its whole link, so a paste into the
  composer is the same chip. The link syntax sits around the label as
  copy-only text (`linkChipCopyParts`). This is true for every chip a link
  draws: a plan, a work, a pull request, a session, a host, a file, an image
  embed, and a mention of a person.
- Not built: chips in the mobile composer. It is a React Native text field,
  which shows the link as text. T3 Code draws its chips in a native editor
  (`t3-composer-editor`), which this app does not ship.
- Mobile reads the same link and opens Hosts. The mobile map, its context menu,
  and the mobile host page follow with the fleet screens (D10).

## Out of scope

- A canvas renderer for more than about 1,000 hosts.
- A cloud summary endpoint for host load (D6).
- Renaming the `api-access` tab id.
- Tags or custom groups for hosts.

## Tests

- Zone placement and the card-to-tile switch for each host kind and count.
- The rollup of a zone: up, retrying, lost, stopped, sessions, and the amber rule.
- The motion gate: no animation class while the map is off screen, hidden, paused,
  or with reduced motion.
- `hostsListSshConfigHosts` lists config machines without patterns or git hosts, and refuses a principal that is not the owner.
- The four new `/v1` routes in `solus-cloud`: owner and member access, a host that
  is not managed, and a deleted host.
