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
| **zone** | One region of the map for one kind of route: Your machines (local network, Tailscale, or the tunnel), SSH and WSL (forwarded), Solus Cloud, and Shared with you. Inside a zone, cloud machines group by organization and shared hosts by owner. |
| **route** | How this device reaches a host. This is the existing `HostRoute` (`docs/plans/host-routes.md`); the map draws it, it does not add a new concept. |
| **tile** | One small square for one host, used when a zone has more hosts than cards fit. |
| **found machine** | A machine that a Discover source sees and that the person has not added. |
| **Discover** | The section of the fleet view that lists found machines, and the scan that finds them. |
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

- This device is at the center. Each zone holds the hosts reached by its route.
  Links go from this device to each host, or to the Solus tunnel and then to the
  cloud and organization zones.
- A link is green when connected, amber and dotted when retrying, red and dotted
  when lost, and a faint dashed hairline when stopped. SSH links are dashed.
- A zone shows a card for each host while the cards fit (`cards` in the zone
  geometry). Past that, it shows one tile for each host, grouped by region or pool,
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
window is visible. They pause when the person pauses the map ("Live"). The
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

A found machine shows in the Discover list, with its source and its own action, and
on the map as a dashed card in the zone where it would go. A full zone shows
"N found". Solus scans again while the page is open (the existing 30 s scan while
the window has focus). Below the list is the install command, for a machine that
no source sees.

### D8. Add a machine: one page, Nearby first, then one choice

"Add machine" opens one page in two parts.

**Nearby** is always at the top. It lists the found machines of D7, each with its
OS logo, its source, and its own action, which finishes in its row: "Connect"
opens a field for the 6-digit code that the machine shows, and "Set up" on a WSL
distro installs Solus there. With no found machine, Nearby says so and offers
Scan again. A machine in reach never needs a choice first.

**Other ways** is one list. The person chooses one, and it opens in place:

1. **Create a cloud machine.** Name, region, size, and an optional setup script.
2. **Link a machine you own.** The install command for macOS and Linux, or Windows,
   with Copy. Then "Waiting for the machine…", then "<name> linked".
3. **Pair with a code.** An address or a pair link, and the 6-digit code. A pasted
   pair link fills both.
4. **Add over SSH.** The only way that opens its own form (`AddOverSshForm`,
   unchanged).

One choice is marked **Recommended**: Nearby when it lists a machine, and otherwise
"Create a cloud machine", which is then first in the list. Nothing in Other ways
opens before the person chooses, except when a link from the map names a way.

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

## Out of scope

- A canvas renderer for more than about 1,000 hosts.
- A cloud summary endpoint for host load (D6).
- Renaming the `api-access` tab id.
- Tags or custom groups for hosts.

## Tests

- Zone placement and the card-to-tile switch for each host kind and count.
- The rollup of a zone: up, retrying, lost, stopped, sessions, and the amber rule.
- The recommendation of D8 with and without found machines.
- The motion gate: no animation class while the map is off screen, hidden, paused,
  or with reduced motion.
- `hostsListSshConfigHosts` lists config machines without patterns or git hosts, and refuses a principal that is not the owner.
- The four new `/v1` routes in `solus-cloud`: owner and member access, a host that
  is not managed, and a deleted host.
