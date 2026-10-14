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
| Personal | The person's choices: theme, models, review, instructions, writing, task lead, and transcript and font presets | A local profile on each client. Signed in, the same profile is also stored in the account. |
| Device | This client only: voice, editor and terminal, font smoothing, installed-font overrides, client analytics consent, zoom, panes, keybindings | The client's local storage. It is never synced. |
| Host | The machine: Solus tool availability, telemetry export, restart recovery, review warming by path, archived automation retention, host analytics consent | `server-settings.json` on the host |
| Organization | Settings that the owners of an organization decide for all its work. Today this is only Sync all Insights. | The control plane, in the organization's host policy. A host reads it in its standing. |

Agents cannot write personal or device settings. On the host, only
`continueSessionsAfterHostRestart` is agent-writable (`HOST_CONFIG_AGENT_WRITABLE`).
A host refuses a `configUpdate` that names any key that is not host config.

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
- Settings → Account & sync is the one place for the account: who is signed in, one sync
  status for settings and the agent profile with both documents' conflicts and the two
  clear actions, and one row per host with its account link and what it holds of the
  agent profile. A conflict is resolved in place, on the tab that holds the value.
- Engine: `packages/client-core/src/document-sync.ts`, bound to settings by
  `settings-sync.ts`. One account sync owner per client holds this engine and the agent
  profile's: `contexts/account/account-sync.store.svelte.ts` on desktop and web,
  `features/account/account-sync.ts` on mobile. The web client calls the account API with an access token from its own
  sign-in (`web-sign-in.ts`), not with the website's cookie. Desktop calls the account
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

Settings → Agent profile holds the person's instructions (the extra instructions, a
personal setting), and their skills, files, and MCP
servers as one document (`docs/agent-profile.md`, plans/020). It syncs with the
same engine and the same rules as personal settings (`client-core/document-sync.ts`
is the one engine; `settings-sync.ts` and `agent-profile-sync.ts` bind it to each
document): synced when signed in, one entry per conflict unit, the same silent first
copy at sign-in, and "Clear synced profile" as its own action on Settings → Account & sync.
The two documents stay apart: no host reads settings, every host reads the profile.
A confirmed write makes every connected host the profile applies to pull it.

| Endpoint | Use |
| --- | --- |
| `GET`, `PATCH`, `DELETE /v1/account/agent-profile` | The caller's document, as for settings |
| `GET`, `POST`, `PUT`, `DELETE /v1/account/agent-profile/connections` | The caller's MCP connections in their account: list, start a sign-in, paste a key, disconnect |
| `POST /v1/agent-profile/read` | A host's read of a person's profile and connection statuses, with the person's delegated token as the bearer and nothing else |
| `POST`, `PUT /v1/agent-profile/credential` | A host's read of an access token for one call, and its one-time upload of a connection it held |

## Organization settings

An organization can enforce only the settings that have an enforcement point. Today
this is one setting:

| Setting | Effect |
| --- | --- |
| `syncAllInsights` | When on, every session of the organization sends its Insights, and members cannot turn this off. When off, Insights go only from managed machines, from explicit shares, and from a host's opt-in. |

A member can read the setting in Settings → Organization. Only an owner can change it.
The change uses a revision check, so two owners cannot overwrite each other without
seeing it. The control plane stores the value in the organization's host policy. Hosts
receive it in their standing, and Insights delivery applies it.

Host eligibility (cloud hosts, personal hosts) and the provisioning defaults for new
managed hosts stay in the cloud console. A client cannot change them.

Organizations cannot set personal choices, such as the permission mode, the task
lifecycle, Solus tools, fonts, or models. A new organization setting needs a product
decision, an enforcement point on the host, and tests before it goes into
`organizationSettingsSchema`.

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
- **Access**: how the host is reached and who reaches it. It has the host's Solus
  Cloud section, its organizations, its network (remote connections, local network
  trust, address), pairing, and the devices with access.
- **Git**, **AI providers**, and **Environment**.

On mobile, a host's settings screen opens an **Access** screen with the same
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
  internet through a Cloudflare tunnel, and does nothing else. Turning it off removes
  only the tunnel. A registered host that is not linked is reached on the local
  network (LAN discovery finds it by its installation id) or by pairing.

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
