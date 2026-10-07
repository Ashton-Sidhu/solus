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
| Personal | The person's choices: theme, models, review, instructions, writing, task lead, and transcript and font presets | A local profile on each client. When sync is on, the same profile is also stored in the account. |
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

- Sync is off by default. The person turns it on for each client install or browser
  profile. Signing in does not turn it on.
- The first time sync is turned on, the client reads the account first. If the account
  has no settings yet, the client offers this device's settings as the first copy. If
  the account has settings, the default is "Use synced settings". "Replace with this
  device" is a separate, explicit choice.
- Edits apply at once on the device and are sent after a short pause. The status
  is "Synced" only after the account confirms the write.
- Each top-level key is one conflict unit. Edits to different keys merge. If two clients
  change the same key, the client shows both values until the person picks one.
- "Turn off on this device" stops transfers. The values stay on the device, and the
  account and other devices do not change.
- "Clear synced settings" removes the account copy and increases its generation. Other
  clients turn sync off when they next connect. An old upload cannot restore the
  cleared settings.
- Sign-out stops sync and removes that account's local view and pending uploads.
- Engine: `packages/client-core/src/settings-sync.ts`. The web client uses the cookie
  adapter. Desktop calls the account API from the main process, so the credential
  never reaches the renderer. Mobile uses its account session token.

API (in the control plane, `solus-cloud`):

| Endpoint | Use |
| --- | --- |
| `GET /v1/account/settings` | Read the caller's document, revision, and generation |
| `PATCH /v1/account/settings` | `set` and `reset` keys, with `expectedRevision` and `generation` |
| `DELETE /v1/account/settings` | Clear the document and increase the generation |
| `GET /v1/orgs/:id/settings` | A member reads the organization settings and `canManageSettings` |
| `PATCH /v1/orgs/:id/settings` | An owner changes Sync all Insights, with `expectedRevision` |

A write with an old revision gets `409 settings_conflict` and the current document.

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
  Cloud link, its organizations, its network (remote connections, local network
  trust, address), pairing, and the devices with access.
- **Git**, **AI providers**, and **Environment**.

On mobile, a host's settings screen opens an **Access** screen with the same
sections in the same order (`HostAccessScreen`). The pairing code shows as a code,
a QR code, and a link to copy. The rules for the organization rows and the pairing
link are shared in `@solus/client-core` (`organization-rows.ts`, `pairing.ts`).

Settings → Account & sync also shows the Solus Cloud link of this computer, when the
desktop app hosts a server here. A browser has no computer to link, so web does not
show it.

The host accepts `uplinkLink` and `uplinkUnlink` only from a local owner: the desktop
on the machine or a paired device (`LOCAL_ONLY_RPC_METHODS`). Thus desktop, web, and
mobile can link any host they are paired with. The ticket comes from the client's own
account. A client that arrived through the Solus Cloud tunnel sees the link but
cannot change it, because an unlink would cut its own connection. A managed host
and the workspace service show no link: Solus Cloud owns how they are reached
(`uplinkControl` in `packages/client-core/src/uplink-control.ts`).

## Release order

Deploy the control plane with the settings tables and API before the clients. Clients
need it for sync and for the Organization page. There is no compatibility with older
hosts, clients, or stored settings: release the host and the clients together.
