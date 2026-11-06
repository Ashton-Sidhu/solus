# Settings: ownership, sync, and organization settings

Plan: `plans/018-settings-sync-and-organization-policy.md`. Contract:
`packages/contracts/src/settings.ts`.

## Who owns a setting

Each setting has one owner, and each owner has its own schema: `PersonalSettings` and
`DeviceSettings` in `packages/contracts/src/settings.ts`, and `HostConfig` in
`packages/contracts/src/host-config.ts`. A key is in one table only.
`tests/unit/settings-resolution.test.ts` fails if two tables share a key.

| Owner | What it holds | Where it is stored |
| --- | --- | --- |
| Personal | The person's choices: theme, models, review, instructions, writing, delegating sessions (in Settings → General), conversation width, and transcript and font presets | A local profile on each client. Signed in, the same profile is also stored in the account. |
| Device | This client only: voice, editor and terminal, font smoothing, installed-font overrides, client analytics consent, zoom, panes, keybindings | The client's local storage. It is never synced. |
| Host | The machine: Solus tool availability, telemetry export, restart recovery, review warming by path, archived automation retention, host analytics consent | `server-settings.json` on the host |
| Organization | Settings that the owners of an organization decide for all its work. Today this is only Sync all Insights. | The control plane, in the organization's host policy. A host reads it in its standing. |

A host refuses a `configUpdate` that names any key that is not host config.

### Agents and settings

An agent reads settings with `read_config` and changes them with `update_config`.
The user does not approve each call. Both tools use five sections, and each
section goes to its owner. `update_config` takes each section except `profile` as
an object of the keys to change. Keys that it does not name keep their values. It
takes `profile` as entries to `set` and keys to `remove`.

| Section | Owner | Writable by an agent | Not available to an agent |
| --- | --- | --- | --- |
| `host` | Host config | Every key except `otel` (`agentHostConfigPatchSchema`) | `otel`, because it holds the collector's credentials. It is not shown. |
| `deviceManager` | The host's device manager | `enabled`, `agentAccessEnabled`, `autoShowAgentDevices`, and `sshHosts` (the whole list) | `onboardingCompleted`, because it records what a client showed. It is UI state, not a setting. |
| `personal` | The person the session works for | Every personal key | — |
| `profile` | The person's agent profile (`docs/agent-profile.md`) | Provider files, skills, and MCP servers | — |
| `device` | The client device that started the turn | Voice, editor and terminal, font smoothing, font overrides, zoom, keybindings (the whole override map), and client analytics consent (`agentDeviceSettingsSchema`) | Layout and UI state: panels, the last project, the sidebar filter, onboarding, the cookie prompt, and the typography fold. An agent cannot set consent back to undecided. |

Each section is checked against its owner's schema before anything is written.
The provider sees the input side of those schemas, so the agent sees each key with
its type and allowed values. A key whose name does not say what it changes has a
`.describe()` text in its owner's schema, and the agent sees that text too. When
you add a setting that an agent can reach, give it a description if its name is not
enough. The listed `update_config` schema is about 4,400 tokens, of which the descriptions are about 1,400. An agent loads it
only when it fetches the tool. When an agent turns off device support, the device
runs stop first, the same as when a person turns it off in Settings
(`configureDevices`).

Device settings never sync, so a `device` change goes only to the client that
started the turn. If that client is not connected, the change fails. The host does
not send it to another of the person's clients, because that is a different
machine. The client applies the change through the same `SettingsContext` setters
that Settings uses, so the device repaints, zooms, and changes analytics consent at
once. The phone app keeps no device settings an agent can change: it answers
`null` and refuses a device change.

An agent writes a profile file as text. The host encodes it and calculates its
hash. The path must be a file inside a provider's profile folders (`isAgentProfilePath`).
`read_config` shows a file by its path, size, and hash, not by its content, because
the files of a profile can total megabytes. It shows skills and MCP servers in full.
The profile never holds a key or a token.

The host does not hold personal settings or the agent profile, so it asks a client
of that person (`personal.agentRequest` in `contracts/agent-personal-request.ts`, a
host-to-client request on the socket). It asks the client that started the turn
first, then the person's other connected clients. It never asks a client of another
person. The client applies the change as a local edit, the same as an edit in
Settings. When the person is signed in, the normal sync sends the change to the
account, and the hosts that the profile applies to pull it. The host never calls
the account API for this. If no client of the person is connected, the tool says
so and changes nothing. A refused key, value, or entry refuses the whole call.

A change to the instructions has an effect from the next turn, because a client
sends the execution preferences with each prompt.

Analytics consent is two settings: `clientAnalyticsEnabled` (device) and the host
config's `analyticsEnabled`. The client emitter stays off until the person chooses.
Sign-in and sync never turn analytics on.

Fonts sync as bundled presets only. An installed family is a device override. It hides
the synced preset on that device, and "Use synced font" removes it.

## Personal sync

- Signed in to Solus Cloud, your settings sync through your account. There is no
  switch per device (plan 018, decision 9). Device settings never sync.
- At sign-in the client reads the account. An account with settings is used as it is.
  An account with none starts from this device's settings. There is no prompt.
- Edits apply at once on the device and are sent after a short pause. The status
  is "Synced" only after the account confirms the write.
- Each top-level key is one conflict unit. Edits to different keys merge. If two clients
  change the same key, the client shows both values until the person picks one.
- "Clear synced settings" removes the account copy and increases its generation, and the
  device you clear on starts the settings again from its own copy. Other devices take
  that copy when they next read. An old upload cannot restore the cleared settings.
- Sign-out stops sync and removes that account's local view and pending uploads.
- A client reads the account copy when it comes to the front or back online, and every
  five minutes while it stays in front. The tabs of one browser share one record, so a
  tab skips its timed read when another tab read the account in the last half period:
  the browser reads about once a period, however many tabs are open.
- Settings → Account & sync is the one place for the account: who is signed in, one sync
  status for settings and the agent profile with both documents' conflicts and the two
  clear actions, and one row per host with its account link and what it holds of the
  agent profile. A conflict is resolved in place, on the tab that holds the value.
- Engine: `packages/client-core/src/document-sync.ts`, bound to settings by
  `settings-sync.ts`. One account sync owner per client holds this engine and the agent
  profile's: `contexts/account/account-sync.store.svelte.ts` on desktop and web,
  `features/account/account-sync.ts` on mobile. The web client calls the account API with an access token from
  `POST /api/web/tokens` (`web-token-session.ts`), not with the website's cookie. Desktop calls the account
  API from the main process, so the credential never reaches the renderer. Mobile calls
  it with an access token from its own sign-in, got for each call
  (docs/adr/0001-standard-authentication.md).

API (in the control plane, `solus-cloud`):

| Endpoint | Use |
| --- | --- |
| `GET /v1/account/settings` | Read the caller's document, revision, and generation |
| `PATCH /v1/account/settings` | `set` and `reset` keys, with `expectedRevision` and `generation` |
| `DELETE /v1/account/settings` | Clear the document and increase the generation |
| `GET /v1/orgs/:id/settings` | A member reads the organization settings and `canManageSettings` |
| `PATCH /v1/orgs/:id/settings` | An owner changes Sync all Insights, with `expectedRevision` |

A write with an old revision gets `409 settings_conflict` and the current document.

## Agent profile sync

Settings → Agent profile holds the person's instructions (the extra and per-model
instructions, personal settings), and their skills, files, and MCP
servers as one document (`docs/agent-profile.md`, plans/020). It syncs with the
same engine and the same rules as personal settings (`client-core/document-sync.ts`
is the one engine; `settings-sync.ts` and `agent-profile-sync.ts` bind it to each
document): synced when signed in, one entry per conflict unit, the same silent first
copy at sign-in, and "Clear synced profile" as its own action on Settings → Account & sync.
The page never fills by itself; on the desktop, "Import from this computer" adds
this computer's skills, files, and MCP servers (`docs/agent-profile.md`).
The two documents stay apart: no host reads settings, every host reads the profile.
A confirmed write makes every connected host the profile applies to pull it.

| Endpoint | Use |
| --- | --- |
| `GET`, `PATCH`, `DELETE /v1/account/agent-profile` | The caller's document, as for settings |
| `GET`, `PUT`, `DELETE /v1/account/vault`, `POST /v1/account/vault/connect` | The caller's account vault (`docs/plans/cloud-vault.md` §2.3): every connection's status, a pasted key, a disconnect, and the start of a sign-in |
| `POST /v1/agent-profile/read` | A host's read of a person's profile and their vault's statuses, with the person's delegated token as the bearer and nothing else |
| `POST /v1/vault/read`, `PUT /v1/vault/credential` | A host's read of a credential for one use, and its one-time upload of a credential it held |

## Organization settings

Organizations lock settings and set limits with **managed policy**. The full guide for
administrators is [Managed policy](managed-policy.md).

- A policy is one `policy.json` document. It comes from the MDM policy of the machine,
  from a cloud host policy that an organization assigns to the host, or from the
  organization policy of the organization.
- A key in a policy is locked to its value. A key that is not in any policy belongs to
  the person. Policy values are never written into personal settings, host settings,
  or records. When a policy goes away, the stored values come back.
- Session settings and limits follow the organization of the work: first the MDM
  policy, then the cloud host policy of that organization, then its organization
  policy. Personal work gets only the MDM policy. The policies of one organization
  never apply to the work of another.
- Host keys are one value for the machine: first the MDM policy, then the host policy
  of the host-owning organization, then the value of the host owner.
- Only keys with an enforcement point on the host are manageable: the models,
  instructions, git conventions, agent autonomy, and review settings, the limits on
  permission mode, providers, models, Insights, and webhooks, and the host keys of
  [Managed policy](managed-policy.md#host-keys-host). Comfort settings are not
  manageable.
- Each lock names its source, for example "Lead model is managed by Globex." The host
  refuses a change to a locked key with `SETTING_MANAGED`, and refuses a run above a
  limit with a message that names the source.
- `syncAllInsights` is now `sessions.limits.insights.syncAll` in the organization
  policy. Owners edit it in Settings → Policy, not in Settings → Organization.

Host eligibility (cloud hosts, personal hosts) and the provisioning defaults for new
managed hosts are host rules, not policy. They stay in the cloud console. A client
cannot change them.

### Execution preferences

Clients send the person's `executionPreferences` (`EXECUTION_PREFERENCE_KEYS`) with
prompts, git actions, reviews, headless sessions, and automations. The host stores
them with the run, the automation, or the task, so background work keeps the
preferences of the person who started it. If a run has no preferences, the host uses
the built-in defaults, not its owner's settings. The host refuses a request whose
preferences contain an unknown key or a bad value. It does not drop the bad value.

## Hosts and the Solus Cloud link

Settings → Hosts lists every host. Each host has its own page:

- **Overview**: whether the host answers, its address, and a summary row for each
  setup step. Each row opens the tab that changes it.
- **Resources**: the CPU and memory of the machine. A host admin also sees Solus and
  the agents it started: totals, CPU use over the last five minutes, and the busiest
  processes. The host samples only while this tab is open. A host without the
  resource monitor shows machine load only. See
  [the plan](plans/resource-telemetry.md).
- **Access**: how the host is reached and who reaches it. It has the host's Solus
  Cloud section, its organizations, its network (remote connections, local network
  trust, address), pairing, and the devices with access.
- **Git**, **AI providers**, and **Environment**.

The Hosts list has an **Auto balance** section when you have two or more hosts
([Run on](run-on.md#auto-balance)).

On desktop, **This computer → Local host** turns off the host that the app runs
here. Solus restarts with no local server: no local agents run, and other devices
cannot connect to this computer. All local data stays, and Solus connects only to
saved hosts. Open tabs on this computer stay read-only. Turn the switch on to
restart with the earlier local settings. The connect page and the command palette
can also turn the local host on (`docs/plans/desktop-remote-only.md`).

On mobile, a host's settings screen opens a **Resources** screen and an **Access**
screen with the same
sections in the same order (`HostAccessScreen`). The pairing code shows as a code,
a QR code, and a link to copy. The rules for the organization rows and the pairing
link are shared in `@solus/client-core` (`organization-rows.ts`, `pairing.ts`).

The Solus Cloud section shows two facts (docs/adr/0001-standard-authentication.md
§2.2 rules 8 and 9):

- **Registered to your account**: the host's identity at Solus Cloud, and the account
  it belongs to. It is automatic. The desktop registers its own host when it signs in.
  Desktop, web (on the account origin), and mobile register a host they are paired
  with when they are signed in. The account, delegations, account reads, and
  organizations need the registration only. If Solus Cloud refuses the registration
  while the host runs (the host was removed from the account, or another copy of it
  registered), the section says so and offers **Register**. Removing a host on the
  account website ends its registration.
- **Reachable from the internet**: the link. The switch exposes the host to the
  internet through a Cloudflare tunnel, and does nothing else. A new registration
  turns it on, so every device you sign in on reaches the host with no second step.
  If the link fails, the section shows why. Turning it off removes only the tunnel,
  and the host stays off until you turn it on again. A registered host that is not
  linked is reached on the local network (LAN discovery finds it by its installation
  id) or by pairing. To give an organization access, share the host with it; the
  link alone gives access only to you.

Settings → Account & sync also shows this section for this computer, when the desktop
app hosts a server here. A browser has no computer of its own, so web does not show it
there.

The host accepts `uplinkRegister`, `uplinkLink`, and `uplinkUnlink` only from a local
owner: the desktop on the machine or a paired device (`LOCAL_ONLY_RPC_METHODS`). The
ticket comes from the client's own account. A client that arrived through the Solus
Cloud tunnel sees both facts but cannot change them, because an unlink would cut its
own connection. A managed host and the workspace service show neither: Solus Cloud owns
them (`uplinkControl` in `packages/client-core/src/uplink-control.ts`).

## Release order

Deploy the control plane with the settings tables and API before the clients. Clients
need it for sync and for the Organization page. There is no compatibility with older
hosts, clients, or stored settings: release the host and the clients together.

## Settings dialog

Settings sections end with a centered divider at 90% of the section width on
desktop, web, and mobile. The divider uses the theme border color in light and
dark mode.

Desktop and web dialogs, sheets, pickers, media dialogs, and their loading
screens use the shared `modal-backdrop` utility: a 4px blur with a theme tint.
Native HTML dialogs apply it to `::backdrop`. The Settings dialog has a maximum
size of 88rem by 66rem, with a 1rem margin at the window edges.
Mobile custom confirmation and document loading dialogs use the existing glass
background, with a solid fallback
where native blur is unavailable. System sheets and alerts keep the operating
system's background.

On desktop and web, Settings opens in a centered dialog over the workspace.
The current page, session, companion pane, and sidebar stay in place. Use the
settings shortcut (`Cmd+,` on macOS or `Ctrl+,` on other platforms), the command
palette, or an existing settings link to open it.

Use the section list and search field to find a setting. In a narrow container,
section buttons replace the list. `Cmd+F` or `Ctrl+F` focuses settings search.
Escape clears an active search first. With no search, Escape closes Settings.
The close button and a press on the background also close it. Focus returns to
the active input. A menu or child dialog handles its own Escape key first.

Settings links keep the `/settings/<section>` path. The optional `from` query
parameter names the page behind the dialog; the existing pane parameters keep
the companion strip and its selection. Refresh, Back, and Forward restore this
state. A direct link with no `from` parameter opens over the conversation pool.

Mobile keeps its native settings navigation: a sheet on compact iOS and a
settings flow on Android and wide layouts. Each returns to the previous
workspace. Settings values, host selection, and provider behavior do not change.

The dialog structure follows the route-backed modal in
[T3 Code](https://github.com/pingdotgg/t3code/blob/main/apps/web/src/components/AppRouteModal.tsx).
Solus uses its existing Svelte dialog primitive and settings stores.
