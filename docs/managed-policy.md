# Managed policy

This page is for administrators. It tells you how to restrict what Solus does and how
to lock settings for the people in your organization. The design is in
[plan 030](../plans/030-managed-policy.md).

## Overview

A policy is one JSON document, `policy.json`. All policies use the same schema. A key
in a policy is **locked** to its value: the person cannot change it, and the host
enforces it. A key that is not in any policy belongs to the person. There are no
unlocked defaults.

A policy comes from one of three sources:

| Source | Where it comes from | What it governs |
| --- | --- | --- |
| **MDM policy** | A file, a macOS configuration profile, or a Windows registry value on the machine | The machine: its host settings and all work on it |
| **Cloud host policy** | A named host policy in Solus Cloud that an organization assigns to hosts | The work of that organization on those hosts |
| **Organization policy** | Solus Cloud. Each organization has one | The work of that organization on all hosts |

The MDM policy needs no Solus Cloud account, no sign-in, and no network. An
organization that does not use Solus Cloud can use the MDM policy alone.

A group of hosts is one cloud host policy that you assign to many hosts, for example
"Engineering laptops" and "CI runners".

## How Solus resolves a key

### Session keys

Session keys are the keys under `sessions`. They follow the organization of the
work. Work is a session, an automation, a task, or a webhook. Work belongs to the
active organization of the person when it starts, and it keeps that organization.

For work of an organization, Solus reads the policies in this order. The first policy
that sets the key wins:

1. the MDM policy of the machine;
2. the cloud host policy that this organization assigned to this host;
3. the organization policy of this organization.

Personal work (`local`) gets only the MDM policy. The policies of one organization
never apply to the work of another organization.

### Host keys

Host keys are the keys under `host`. One machine has one value for each host key, for
example one bind address. Solus reads host keys in this order:

1. the MDM policy;
2. the cloud host policy of the **host-owning organization**;
3. the value that the owner of the host set.

The host-owning organization is the organization whose assigned host policy holds
the `host` section on this host. Only one organization can hold the `host` section
on a host. The first organization that assigns a host policy with `host` becomes the
owner. Solus Cloud refuses an assignment from another organization when its document
contains `host`, and the refusal names the organization that holds it. That
organization can still assign a host policy that has only `sessions`. On a managed
cloud host, the organization of the host always holds the section.

### Example

Bob's laptop is shared with Acme and Globex.

- Acme assigns "Acme laptops": `host.analyticsEnabled: false` and
  `sessions.limits.maxPermissionMode: full-access`.
- Globex assigns "Globex laptops": `sessions.limits.maxPermissionMode: supervised`.
- The organization policy of Globex sets `sessions.settings.leadModel` to Opus.

| Bob's active organization | Mode limit | Lead model | Analytics on the laptop |
| --- | --- | --- | --- |
| Personal (`local`) | none | his own | off (Acme holds `host`) |
| Acme | `full-access` | his own | off |
| Globex | `supervised` | Opus, locked | off |

### How to remove a cloud policy from a host

- An owner of the organization removes the assignment.
- Or the owner of the host stops sharing the host with the organization. This deletes
  the assignment of that organization.

The settings page of the host lists each organization that has a host policy on the
host, and names the host-owning organization.

## The document

```json
{
  "schemaVersion": 1,
  "organization": { "name": "Example Corp" },
  "name": "Engineering laptops",
  "supportUrl": "https://it.example.com/solus",
  "host": {
    "remoteAccess": false,
    "cloudTunnel": false,
    "analyticsEnabled": false,
    "updates": { "mode": "auto", "feedUrl": "https://updates.example.com/solus/" }
  },
  "sessions": {
    "settings": { "extraInstructions": "Never push to main." },
    "limits": {
      "maxPermissionMode": "accept-edits",
      "providers": {
        "allowed": ["claude-code"],
        "launch": { "claude-code": { "environment": [{ "name": "CLAUDE_CODE_USE_BEDROCK", "value": "1" }] } }
      },
      "models": { "claude-code": ["claude-opus-5-5", "claude-sonnet-5-5"] }
    }
  }
}
```

### Top-level keys

| Key | Required | What it does |
| --- | --- | --- |
| `schemaVersion` | Yes | Must be `1`. |
| `organization.name` | Yes | Solus shows it as "Managed by <name>" and in each lock and refusal. |
| `name` | No | The name of the policy, for example "Engineering laptops". |
| `supportUrl` | No | An `https` URL where people get help. |
| `revision` | No | Solus Cloud sets it when you save. An export keeps it, so a host shows which revision it runs. |
| `host` | No | Host keys. Not permitted in an organization policy. |
| `sessions.settings` | No | Locked session settings. |
| `sessions.limits` | No | Session limits. |

Each object is strict. Solus refuses a key that it does not know or cannot enforce.

### Host keys (`host`)

| Key | What it does |
| --- | --- |
| `solusTools` | Turns each configurable Solus tool on (`true`) or off (`false`). |
| `continueSessionsAfterHostRestart` | Whether sessions continue after the host restarts. |
| `archivedAutomationRetentionDays` | Days to keep archived automations, 1 to 3650. |
| `unfiledRecordingRetentionDays` | Days to keep recordings that are not filed, 1 to 3650. |
| `otel` | OpenTelemetry export: `enabled`, `endpoint`, `headers`, `exportMetrics`, `exportTraces`. Under this lock the host ignores the `OTEL_EXPORTER_OTLP_*` environment variables. |
| `analyticsEnabled` | Product analytics from the host **and** from the desktop app on this machine. `false` turns both off, whatever the person chose. A web client reads the policy of the host that served it. |
| `remoteAccess` | `false`: the host listens only on loopback. LAN discovery is off. Pairing codes, pair links, and host introductions are refused. Devices that paired from another machine before the policy are signed out. |
| `trustLocalNetwork` | `false`: requesters on the local network must pair. You cannot set `true` when `remoteAccess` is `false`. |
| `cloudTunnel` | `false`: no Solus Cloud tunnel. The host refuses a link, and a stored link does not resume. Registration with Solus Cloud still works, because the host needs it to get its cloud policies. |
| `updates.mode` | `auto` or `off`. `off`: the desktop app does not check for updates, and its update controls say "<Name> manages Solus updates." The host and `solus update` refuse to update. |
| `updates.feedUrl` | An `https` URL of a generic update feed. The desktop app updates from this feed instead of the Solus releases. |

### Session settings (`sessions.settings`)

Each key takes the same value as the personal setting of the same name. The host reads
each key from the request it serves, so a lock holds even against a modified client.

| Purpose | Keys |
| --- | --- |
| Models | `leadModel`, `workerModel`, `modelRouting`, `textGenerationModel`, `sourceControlWriterModel` |
| Instructions | `extraInstructions`, `modelInstructions`, `leadInstructions` |
| Git conventions | `sourceControlWriting`, `worktreeBranchNaming` |
| Agent autonomy | `defaultPermissionMode`, `agentTaskLifecyclePolicy`, `rateLimitBehavior` |
| Reviews | `reviewAgent`, `reviewModel`, `reviewGuideInstructions` |

`leadModel: null` locks "the default for new sessions".

Auto model routing (`modelRouting`) sends prompts to an external classifier. To
prevent this, lock `modelRouting` off.

Comfort settings (fonts, theme, layout, notifications) are not manageable.

### Session limits (`sessions.limits`)

| Key | What it does |
| --- | --- |
| `maxPermissionMode` | The highest permission mode. The order is `plan` < `supervised` < `accept-edits` < `auto` < `full-access`. A run above the limit is refused. A default or an automatic grant is lowered to the limit. An old session above the limit gets no turns until the person sends a lower mode. |
| `providers.allowed` | The only providers that can run: `claude-code`, `codex`, `opencode`, `replay`. |
| `providers.launch` | For each provider: `environment` (a list of `{ name, value }`), `binaryPath`, and `launchArgs` that every launch uses. Under a `maxPermissionMode`, the launch fields of the person are not used. Only these pins and the Solus defaults apply. |
| `models` | For each provider, the only model ids that can run. A provider that is not named is not limited. |
| `insights.syncAll` | `true`: every session of the organization sends its Insights. Off or absent: the opt-in of the host decides. |
| `webhooks.allowUnverified` | `false`: a webhook with verification `none` cannot start work. An MDM policy that sets it also covers personal webhooks. |

A new organization starts with this organization policy:

```json
{ "schemaVersion": 1, "organization": { "name": "<name>" },
  "sessions": { "limits": { "insights": { "syncAll": true }, "webhooks": { "allowUnverified": false } } } }
```

### Rules across keys

Solus Cloud, the editor, the host, and `solus policy check` all apply these rules:

- An organization policy cannot contain `host`.
- `sessions.settings.defaultPermissionMode` cannot be above
  `sessions.limits.maxPermissionMode`.
- A locked model setting must be in `sessions.limits.models` for its provider, when
  the policy sets that list. Its provider must be in `providers.allowed`, when the
  policy sets that list.
- The name of a launch environment variable must start with a letter or `_`, and
  contain only letters, digits, and `_`.
- `host.updates.feedUrl` and `supportUrl` must be `https`.
- `host.trustLocalNetwork: true` is refused when `host.remoteAccess` is `false`.

## Install an MDM policy

Put the policy in **one** of the native sources of the operating system:

| OS | Native source | File |
| --- | --- | --- |
| macOS | Device configuration profile for the domain `com.solus.app` (Solus reads `/Library/Managed Preferences/com.solus.app.plist`) | `/Library/Application Support/Solus/policy.json` |
| Windows | Value `Policy` (`REG_SZ`, one line of JSON) under `HKLM\SOFTWARE\Policies\Solus` | `C:\ProgramData\Solus\policy.json` |
| Linux | — | `/etc/solus/policy.json` |

The desktop app and the standalone server use the same reader.

Make sure that only an administrator can write the file. The host logs the warning
`mdm_policy_user_writable` when the user who runs Solus can write it.

### macOS configuration profile

Make a device payload for the preference domain `com.solus.app`. The keys of the
payload are the top-level keys of the document (`schemaVersion`, `organization`,
`host`, `sessions`, and so on). The editor in Settings → Policy exports
`com.solus.app.mobileconfig` for you.

A profile cannot hold `null`. If your policy needs `null` (for example
`leadModel: null`), use the file.

Solus converts the profile with `/usr/bin/plutil -convert json`.

### Windows registry

Write the document as one line of JSON:

```powershell
New-Item -Path 'HKLM:\SOFTWARE\Policies\Solus' -Force | Out-Null
$policy = Get-Content -Raw 'policy.json' | ConvertFrom-Json | ConvertTo-Json -Depth 20 -Compress
Set-ItemProperty -Path 'HKLM:\SOFTWARE\Policies\Solus' -Name 'Policy' -Type String -Value $policy
```

The editor exports `Set-SolusPolicy.ps1`, which does the same. Solus reads the value
with `reg query`.

### When a change applies

The host reads the MDM policy once, when it starts. After you install, change, or
remove the policy, restart Solus. Use `solus policy show` to see whether the running
host has the installed policy.

### Dev builds

Only a dev build reads `SOLUS_DEV_POLICY_PATH`. A release build ignores it.

## Refusal to start

The host does not start when:

- two MDM sources are installed (for example the file and a profile). The error names
  both;
- it cannot read the source;
- the document does not pass the validator.

The error names the source and the reason, and tells you to run `solus policy check`.

- **Desktop app:** the boot-error card shows the message. Nothing else starts.
- **Standalone server:** the server logs `mdm_policy_refused` and exits with a code
  that is not zero.

A policy that the host cannot fully enforce never runs as if it were enforced.

## How cloud policies reach a host

- The host gets its **standing** from Solus Cloud: for each organization, its
  organization policy, the host policy it assigned to this host, and the host rules.
  The standing also names the host-owning organization.
- The host asks when it registers, on demand, and **every 60 seconds with an ETag**. An
  answer that did not change costs no new download.
- The host keeps the last standing on disk in `<dataDir>/organization-standing.json`
  (mode 0600), and loads it when it starts. A host that restarts while it is offline
  keeps its cloud policies. An unlink, or a 401 or 404 answer, deletes the file.
- A new standing applies at once. Host keys change immediately. Session keys apply at
  the next run.
- **Fail closed:**
  - When the host has no standing for an organization, fresh or cached, it refuses
    that organization's work with "This host has not received this organization's
    policy yet."
  - When this Solus version cannot read a cloud document, it refuses that
    organization's work and asks for an update of Solus. If that organization owns the
    host, the host refuses all work, because it cannot apply the `host` section.

Owners edit the organization policy and the host policies in Settings → Policy on the
desktop app or the web client. They assign host policies from the host list of the
organization. Each write checks the revision, so two owners cannot overwrite each other
without seeing it. Solus Cloud audits each change.

## Check a policy

### `solus policy check FILE`

Runs the validator on a file before you install it.

- When the document is valid, it prints the fingerprint and what the policy does: the
  locked host keys, the locked session settings, and the limits. It exits with 0.
  It prints only the names of launch environment variables, never their values.
- When the document is not valid, it prints each issue and exits with 1.

### `solus policy show`

Shows what is installed and what the running host enforces:

- the installed MDM source and its fingerprint, or "No MDM policy is installed.";
- whether the running host has the same fingerprint. When it does not, it prints
  "Restart Solus to apply the installed policy.";
- the cloud policies that the host holds, with their revisions.

The fingerprint is the first 12 hex characters of the SHA-256 of the canonical JSON of
the document (sorted keys, no spaces). Key order does not change it.

Both commands work with the `solus` command of the desktop app and of the standalone
server.

## What a policy does not cover

- **A permission-mode limit is not a sandbox.** Claude Code reads
  `~/.claude/settings.json` and the project settings. Allow rules and hooks there can
  approve tools. Use the managed settings of Claude Code for those. Codex is the same
  with its own config.
- **A locked instruction is not a security boundary.** An agent can still disobey it.
- **A user with administrator rights can remove an MDM policy.** A Solus version from
  before managed policy ignores it. Use the application controls of your MDM tool to
  choose which builds run.
- **The environment of the host process reaches providers.**
- **Without remote access**, a user can still forward the loopback port with other
  tools, for example Tailscale or SSH.
- **A web client** that opens a remote host keeps its own analytics choice. Only the
  host that served the web client decides its analytics.
- **The standalone server updates from GitHub.** `updates.feedUrl` applies only to the
  desktop app. Pin the standalone server with the package tools of your organization.
- **A removed feed URL** applies at the next start of the desktop app.
