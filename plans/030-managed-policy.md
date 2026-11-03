# 030 Managed policy — host policies and organization policies

- Status: PLAN (2026-11-02). Not implemented.
- Baseline: Solus `ff7c5972a` (main); solus-cloud working tree of the same date.
- Replaces: plan 018 decision 7 for the limits and settings named here; the
  `organizationPolicySchema` / `organizationSettingsSchema` pair; and
  `HostOrganizations.policyFor` with its fail-open default.
- Reference: t3code managed policy (`pingdotgg/t3code` at `8657eecb`:
  `docs/user/managed-policy.md`, `packages/contracts/src/managedPolicy.ts`,
  `apps/server/src/policy/`, `apps/server/src/orchestration-v2/DispatchModeLimit.ts`).

## 1. Purpose

An administrator restricts what Solus does and locks settings. Every policy uses one
`policy.json` schema. There are three sources:

| Source | Where it comes from | What it governs |
| --- | --- | --- |
| **MDM policy** | A file, a macOS configuration profile, or a Windows registry value on the machine | The machine: its host settings and every session on it |
| **Cloud host policy** | A named host policy in Solus Cloud that an organization assigns to hosts | That organization's work on those hosts |
| **Organization policy** | Solus Cloud, one for each organization | That organization's work on any host |

A group of hosts is one cloud host policy assigned to many hosts, for example
"Engineering laptops" and "CI runners". The MDM policy needs no Solus Cloud account,
no sign-in and no network, so an organization that is not on Solus Cloud can still
use Solus securely.

## 2. Decisions

User decisions, 2026-11-02:

1. **One schema.** All three sources use the same document, validator and
   evaluator. An MDM policy and a cloud host policy are the same document delivered
   in two ways, and the editor exports one as the other.
2. **Policy is keyed by the active organization.** The policies of the organization
   that work belongs to apply to it: that organization's cloud host policy for this
   host, and its organization policy. Another organization's policies never apply to
   it. Work belongs to the user's active organization when it starts (the window's
   selection, `windowOrganization` in `turn-organization.ts:176`), and it keeps that
   organization. `local` work has no cloud policy.
3. **Each organization can assign one host policy to a host.** Several organizations
   can assign host policies to the same host. Each one applies only to its own work.
4. **The MDM policy applies to all work on the machine, and it wins.** The machine's
   administrator answers for the machine. Then the active organization's cloud host
   policy applies, then its organization policy.
5. **A setting is managed or not managed.** A key in a policy is locked to the
   policy's value. A key that is not in any policy is the person's own. There are no
   unlocked defaults.
6. **Only some settings are manageable.** A key is manageable only when the host
   enforces it (§4.3, §4.4). Comfort settings are not manageable.
7. **A host policy can apply to a person's own computer**, through MDM or through a
   cloud assignment to a host that is shared with the organization.
8. **Old sessions are governed.** A session above the ceiling is refused turns until
   a lower mode is sent. Lowering is always allowed.
9. **Plan 018 decision 7 is reversed** for every limit and setting in §4.
10. **One pass, with no compatibility layer.** There are no users. The databases are
    rebuilt from the baseline (plan 029).

Design rules taken from t3code:

11. **A policy is a value.** The document holds everything it needs. Delivery is
    separate from evaluation.
12. **Strict, and fail closed.** A document that does not pass the validator is not
    enforced, and nothing it would govern runs. A bad MDM policy stops the host at
    startup.
13. **Overlay; never write.** Policy values are never written into a person's
    settings, the host's settings, or records. Removing a policy brings the stored
    values back.
14. **An absent key means no rule.**
15. **Clients get a summary, not the source.**

## 3. Resolution

```
policiesFor(org) = [ mdm, org === 'local' ? null : hostPolicy(org, thisHost), org === 'local' ? null : orgPolicy(org) ]

resolveSession(key, work) = first of policiesFor(work.organizationId) that sets key ?? no rule
resolveHost(key)          = mdm.host[key] ?? hostOwner(thisHost).host[key] ?? the host owner's stored value
```

`work.organizationId` is the organization of the session, the automation, the task
or the webhook.

**Session keys** (`sessions.*`) follow the work's organization.

**Host keys** (`host.*`) are one value for the whole machine. One machine cannot have
two values for `analyticsEnabled` or for its bind address. So host keys come from:

1. the MDM policy;
2. otherwise the **host-owning organization**: the organization whose cloud host
   policy holds the `host` section on this host;
3. otherwise the host owner's stored value.

Only one organization can hold the `host` section on a host. The first organization
whose assigned host policy contains `host` becomes the host-owning organization. The
cloud refuses an assignment from another organization when its document contains
`host`, and names the organization that holds it. Its `sessions` section can still
be assigned. A managed cloud host's own organization always holds the section.

Example. Bob's laptop is shared with Acme and Globex.

- Acme assigns "Acme laptops": `host.analyticsEnabled: false`,
  `sessions.limits.maxPermissionMode: full-access`.
- Globex assigns "Globex laptops": `sessions.limits.maxPermissionMode: supervised`.
- Globex's organization policy: `sessions.settings.leadModel: opus`.

| Bob's active organization | Mode limit | Lead model | Analytics on the laptop |
| --- | --- | --- | --- |
| Personal (`local`) | none | his own | off (Acme holds `host`) |
| Acme | `full-access` | his own | off |
| Globex | `supervised` | Opus, locked | off |

**The way out.**

- An owner removes the assignment.
- Or the host's owner stops sharing the host with the organization, which deletes its
  assignment.
- The host's settings page lists each organization with a host policy on the host,
  and names the host-owning organization.

**Host rules are not policy.** `allowCloudHosts`, `allowPersonalHosts` and the
provisioning defaults stay in `organization_host_policy` as **host rules**. They
decide which cloud resources an organization uses.

## 4. The document

### 4.1 Schema

New file `packages/contracts/src/policy.ts`. solus-cloud gets it through its shared
contract copy.

```ts
export const policyDocumentSchema = z.object({
  schemaVersion: z.literal(1),
  /** Shown as "Managed by <organization.name>". */
  organization: z.object({ name: z.string().trim().min(1) }).strict(),
  /** The policy's own name, such as "Engineering laptops". */
  name: z.string().trim().min(1).optional(),
  supportUrl: httpsUrlSchema.optional(),
  /** Set by Solus Cloud on save; kept in an export so a host shows which revision it runs. */
  revision: z.number().int().nonnegative().optional(),
  /** Host policies only: machine-wide (§4.4). */
  host: managedHostSettingsSchema.optional(),
  sessions: z.object({
    settings: managedSettingsSchema.optional(),
    limits: z.object({
      /** plan < supervised < accept-edits < auto < full-access */
      maxPermissionMode: z.enum(PERMISSION_MODES).optional(),
      providers: z.object({
        allowed: z.array(agentIdSchema).nonempty().optional(),
        /** Fields pinned on every instance of a provider (§6.4). */
        launch: z.record(agentIdSchema, providerLaunchPinSchema).optional(),
      }).strict().optional(),
      /** By provider: the only model ids that may run. A provider not named is not limited. */
      models: z.record(agentIdSchema, z.array(z.string().min(1)).nonempty()).optional(),
      /** On: every organization session sends its Insights. Off or absent: the host's opt-in decides. */
      insights: z.object({ syncAll: z.boolean() }).strict().optional(),
      /** false: a webhook with verification `none` cannot start work. */
      webhooks: z.object({ allowUnverified: z.boolean() }).strict().optional(),
    }).strict().optional(),
  }).strict().optional(),
}).strict()

const providerLaunchPinSchema = z.object({
  environment: z.array(z.object({ name: envNameSchema, value: z.string() })).optional(),
  binaryPath: z.string().trim().min(1).optional(),
  launchArgs: z.string().trim().min(1).optional(),
}).strict()
```

An example of an MDM policy:

```json
{
  "schemaVersion": 1,
  "organization": { "name": "Example Corp" },
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

### 4.2 Rules that cross keys

The host, the cloud, the editor and `solus policy check` all run these rules:

- An organization policy must not contain `host`.
- `sessions.settings.defaultPermissionMode` must not be above
  `sessions.limits.maxPermissionMode`.
- Locked model settings (`leadModel`, `workerModel`, `textGenerationModel`,
  `sourceControlWriterModel`) must be in `sessions.limits.models` when the policy
  sets it.
- A launch pin's `environment` follows the name rules of provider instances
  (`provider-instances.ts:10`). Its `launchArgs` follow the argument rules (`:57`).
- `host.updates.feedUrl` must be `https`.
- `host.trustLocalNetwork: true` is refused when `host.remoteAccess` is `false`.

### 4.3 Manageable session settings (`sessions.settings`)

`managedSettingsSchema` is a strict object. Each key is optional and takes the value
schema of the personal setting (`PERSONAL_SETTING_SCHEMAS`). The host reads each key
from the request it serves, so a lock holds even against a modified client.

| Purpose | Keys | Where the host reads it |
| --- | --- | --- |
| Models | `leadModel`, `workerModel`, `modelRouting`, `textGenerationModel`, `sourceControlWriterModel` | execution preferences (`run-input.ts:54/63`) |
| Instructions | `extraInstructions`, `modelInstructions`, `leadInstructions` | execution preferences |
| Git conventions | `sourceControlWriting`, `worktreeBranchNaming` | execution preferences |
| Agent autonomy | `defaultPermissionMode`, `agentTaskLifecyclePolicy`, `rateLimitBehavior` | execution preferences |
| Reviews | `reviewAgent`, `reviewModel`, `reviewGuideInstructions` | request `ctx.settings` (`guide-warmer.ts:80/194`, `guide-producer.ts:224`) |

These are not manageable:

- comfort settings (fonts, theme, layout, notifications, `showToolCalls`);
- `responseStreamingMode`, `autoRenameSessions`, `handoffHistoryTokens`;
- `activeAgent` and `defaultModels`.

Note: Auto model routing (`modelRouting`) sends prompts to an external classifier
(`model-routing.ts:18`). To prevent this, lock `modelRouting` off.

### 4.4 Manageable host settings (`host`)

`managedHostSettingsSchema` is a strict object. Each key is optional.

| Key | What it controls | Where the host enforces it |
| --- | --- | --- |
| `solusTools`, `continueSessionsAfterHostRestart`, `archivedAutomationRetentionDays`, `unfiledRecordingRetentionDays` | The host config of the same name (`host-config.ts:93`) | `getHostConfig` / `setHostConfig` (`host/settings.ts:155/195`) |
| `otel` | OTEL export | The same as above. Under a lock, the `OTEL_EXPORTER_OTLP_*` variables are also ignored (`otel.ts:49-60`). |
| `analyticsEnabled` | Product analytics from the host (`analytics.ts:31`) **and** from the desktop app on this machine (`lib/analytics.ts`, started at `desktop-runtime.svelte.ts:94`) | Host config, and the desktop main process (§5.4) |
| `remoteAccess` | `false`: the host listens only on loopback. LAN discovery is off, pairing codes and pair links are refused, and devices paired before the policy are signed out. | §6.7 |
| `trustLocalNetwork` | `false`: requesters on the local network must pair | `trusted-requesters.ts:30` |
| `cloudTunnel` | `false`: no Solus Cloud tunnel. `uplinkLink` is refused, and a stored link does not resume. | §6.7 |
| `updates` | `{ mode: 'auto' \| 'off', feedUrl? }` for the desktop app and the host | §6.8 |

`reviewWarmingByProject` is a store for each project, so it is not manageable.

A new key enters either schema only with an enforcement point and a test.

### 4.5 A new organization

A new organization gets an organization policy that holds today's defaults:

```json
{ "schemaVersion": 1, "organization": { "name": "<name>" },
  "sessions": { "limits": { "insights": { "syncAll": true }, "webhooks": { "allowUnverified": false } } } }
```

## 5. Where policies come from

### 5.1 MDM policy

`packages/server/src/host/policy/mdm-policy.ts` reads the policy once, when the host
process starts. The desktop app and the standalone server use the same reader.

| OS | Native source | File |
| --- | --- | --- |
| macOS | Device configuration profile for the domain `com.solus.app` (`/Library/Managed Preferences/com.solus.app.plist`) | `/Library/Application Support/Solus/policy.json` |
| Windows | `Policy` (`REG_SZ`, one line of JSON) under `HKLM\SOFTWARE\Policies\Solus` | `C:\ProgramData\Solus\policy.json` |
| Linux | — | `/etc/solus/policy.json` |

- **Reading the native sources.** No native module exists today, and the standalone
  server is a Node archive (`scripts/package-server.ts`), so the reader uses system
  tools:
  - macOS: `plutil -convert json -o - <plist>`. The payload's keys are the document's
    top-level keys. A profile cannot hold `null`, so a key that needs `null` uses the
    file.
  - Windows: `reg query HKLM\SOFTWARE\Policies\Solus /v Policy`. If organizations
    block `reg.exe`, stop and ask (§10).
- **Two sources on one machine:** the host does not start, and the error names both.
- **A source the host cannot read, or a document that does not pass the validator:**
  the host does not start, and the error names the source and the reason. The
  desktop app shows it on its boot-error card (`apps/desktop/src/main/index.ts:840`),
  with `solus policy check`. The standalone server exits with a non-zero code and logs
  `mdm_policy_refused`.
- **Release builds have no override.** Dev builds read `SOLUS_DEV_POLICY_PATH`.
- **A change takes effect at the next host start.** `solus policy show` tells IT
  whether the running host loaded the installed policy (§7).
- **The host logs a warning** when the file is writable by the user who runs it.

### 5.2 Solus Cloud

- **Tables** (solus-cloud baseline):
  - `policy`: `id`, `organization_id`, `kind` (`organization` | `host`), `name`,
    `document` jsonb, `revision`, `updated_at`. Each organization has exactly one row
    of kind `organization` (§4.5) and any number of rows of kind `host`.
  - `host_policy_assignment`: `host_id`, `organization_id`, `policy_id`,
    `assigned_by`, `assigned_at`. The primary key is `(host_id, organization_id)`:
    each organization assigns one host policy to a host.
  - `host_owner`: `host_id` PK, `organization_id`. This is the host-owning
    organization of §3. It is set when an assignment brings a `host` section, and
    cleared when that assignment goes away.
  - `organization_host_policy` keeps `allow_cloud_hosts`, `allow_personal_hosts`,
    `default_packages`, `default_setup_script`, `revision`. It loses
    `sync_all_insights` and `allow_unverified_webhooks`, which move into the
    organization policy.
- **API.** Organization owners only. Each write is checked against the revision,
  validated and audited.
  - `GET/PUT /v1/orgs/:id/policy`: the organization policy.
  - `GET/POST /v1/orgs/:id/host-policies` and
    `GET/PUT/DELETE /v1/orgs/:id/host-policies/:policyId`.
  - `PUT/DELETE /v1/orgs/:id/hosts/:hostId/policy`: assign this organization's host
    policy to a host, or remove it.
    - Allowed only for a host shared with the organization or managed by it.
    - An assignment whose document contains `host` is refused when another
      organization owns the host.
    - Editing an assigned host policy so that it adds `host` follows the same rule.
  - A 409 returns the current document.
  - Audit events: `policy_changed`, `host_policy_assigned`, `host_policy_unassigned`.
  - Unsharing a host deletes the organization's assignment for it.
  - `/v1/orgs/:id/settings` and `organizationSettingsSchema` are removed. The
    Insights switch moves into the editor.
- **Standing.** `GET /v1/hosts/:hostId/organizations` gives, for each organization:
  - `policy`: its organization policy;
  - `hostPolicy`: the host policy it assigned to this host, or null;
  - `hostRules`: `{ allowsCloudHosts, allowsPersonalHosts }`.

  It also gives `hostOwnerOrganizationId` once. This replaces
  `organizationPolicySchema` and `DEFAULT_ORGANIZATION_POLICY`.
- **Cache.** `HostOrganizations` (`host/organizations.ts`) persists the last standing
  to `<dataDir>/organization-standing.json` (mode 0600), and loads it at start,
  before the first fetch.
  - The cache exists so that a host does not lose its cloud policies on a restart
    while it is offline.
  - An unlink, or a 401 or 404 answer, deletes it.
- **Live update.** A new standing applies at once. Host keys change through
  `config.changed` and a rebind (§6.7). Session keys change at the next run.

### 5.3 Fingerprint

The fingerprint of a document is the SHA-256 of its canonical JSON (sorted keys, no
spaces), as 12 hex characters. The host reports the loaded MDM fingerprint and, for
each cloud policy, its revision, in `connectionsGetServerInfo`.

### 5.4 The desktop app

The desktop main process needs `analyticsEnabled` and `updates` before the renderer
starts.

- It runs the same MDM reader before `bootCore`. A refusal shows the boot-error card,
  and nothing else starts.
- For cloud host keys, it asks the embedded host's gate (`resolveHost`) after boot.
- The renderer turns analytics off when `resolveHost('analyticsEnabled')` is
  `false`. This works whatever the person's `clientAnalyticsEnabled` is.
- A web client that opens a remote host keeps its own analytics choice. The docs say
  this.

## 6. Enforcement on the host

### 6.1 One owner

`packages/server/src/host/policy/policy-gate.ts` is the only module that reads a
policy document.

```ts
interface PolicyGate {
  resolveSession<K extends SessionPolicyKey>(organizationId: string, key: K): ResolvedRule<K> | null
  resolveHost<K extends HostPolicyKey>(key: K): ResolvedRule<K> | null
  /** Refuse a run above the ceiling, on a provider not allowed, or on a model not allowed. */
  checkRun(organizationId: string, run: { mode: PermissionMode; provider: AgentId; model: string | null }): void
  /** A default or an automatic grant, lowered to the ceiling. */
  clampMode(organizationId: string, mode: PermissionMode): PermissionMode
  isProviderAllowed(organizationId: string, provider: AgentId): boolean
  isModelAllowed(organizationId: string, provider: AgentId, model: string): boolean
  launchConfig(organizationId: string, provider: AgentId, instance: ProviderInstance | null): ProviderInstance | null
  applySettings(organizationId: string, preferences: ExecutionPreferences, settings: RequestSettings): { preferences: ExecutionPreferences; settings: RequestSettings }
  applyHostSettings(config: HostConfig): HostConfig
  syncAllInsights(organizationId: string): boolean
  allowsUnverifiedWebhooks(organizationId: string): boolean
  summary(): PolicySummary
}
```

`ResolvedRule` carries the value and its source, for example "MDM policy of Example
Corp", "Globex laptops (Globex)", or "Globex". Each lock and each refusal names that
source.

A refusal is a `PolicyRefusedError`:

- Codes: `PERMISSION_MODE_ABOVE_LIMIT`, `PROVIDER_NOT_ALLOWED`, `MODEL_NOT_ALLOWED`,
  `SETTING_MANAGED`, `REMOTE_ACCESS_NOT_ALLOWED`, `CLOUD_TUNNEL_NOT_ALLOWED`,
  `UPDATES_MANAGED`, `POLICY_UNAVAILABLE`, `POLICY_UNENFORCEABLE`.
- Messages: `"<Source> limits sessions to <Mode>."`, `"<Source> does not allow
  <thing>."`, `"<Setting> is managed by <Source>."`

### 6.2 Fail closed

- An organization that is not in the standing, fresh or cached: its work is refused
  with `POLICY_UNAVAILABLE`.
- A cloud document that this Solus version cannot decode: that organization's work
  is refused with `POLICY_UNENFORCEABLE` ("Update Solus"). If that organization owns
  the host, all work on the host is refused too, because its `host` section cannot
  be applied.
- A bad MDM policy stops the host (§5.1).

### 6.3 Permission-mode ceiling

The inventory of 2026-11-02 found that `admitTurn` reads no mode and no provider, and
that many paths start provider work without it: queue drains, restart recovery,
rate-limit releases, steering, `send_session`, plan approval, automations, webhooks,
reviews, lenses and text generation.

- **Backstop: `AgentRunner.run`** (`agent-runner.ts:108`, before `backend.startRun`
  at `:194`). Every provider process passes here.
  - `AgentRunRequest` gets a required `organizationId`, so the compiler finds every
    caller.
  - The runner calls `checkRun` with the mode, the provider and the final model. On a
    refusal, nothing starts.
- **Steering.** `run-launcher.ts:123` and `run-scheduler.ts:239` call `checkRun` with
  the active run's mode, because a policy can change during a run.
- **Early refusal at the RPC:**
  - `prompt`, `retry`, `sessionQueueChange`, `compactSession`,
    `createHeadlessSession` and `promptHeadlessSession` check the mode with zod and
    call `checkRun`.
  - They also get the guest override that `retry`, `sessionQueueChange` and
    `compactSession` lack today.
- **Clamp points**, which lower the mode instead of refusing:
  - `prompt-dispatch.ts:321`: the default for a new session.
  - `prompt-dispatch.ts:422` `startUnattendedSession`, hardcoded `'full-access'`,
    used by automations and webhooks.
  - `prompt-dispatch.ts:229`.
  - `session-orchestrator.ts:471` `approvePlan`, which sends `'full-access'`.
  - `text-generator.ts:57`: Claude runs as `'full-access'`. It moves to the narrowest
    mode that works with tools off. If none works, stop and ask.
  - `claude-agent.ts:315`: the default `'full-access'` becomes a required mode.
- **Inside a Claude run:**
  - `claude-permissions.ts:40` removes `setMode` suggestions above the ceiling.
  - When the SDK reports a mode change above the ceiling
    (`claude-event-normalizer.ts:375`), the run stops.
- **Old sessions.** Clients send the mode with each prompt, so the user lowers it in
  the picker. Queued and restored runs above the ceiling fail at the backstop with
  "Lower the mode to continue."

### 6.4 Provider launch config

`prepareProviderRun` (`provider-runtime.ts:41`) calls `launchConfig` on every path.
This includes its two early returns: no acting person (`:44`), and Codex without
overrides (`:47`).

- **With a ceiling:** the person's `binaryPath`, `launchArgs`, `environment`,
  `homePath` and `shadowHomePath` are dropped. Only the `providers.launch` pins and the
  Solus defaults apply. Today `launchArgs` does not block
  `--dangerously-skip-permissions` (`provider-instances.ts:57`).
- **Without a ceiling:** the pins are laid over the person's instance.
- **`providerInstancesWrite`** (`settings-handlers.ts:27`) refuses a change to a field
  the policy owns. The stored values are kept.
- **The seat token** (`CLAUDE_CODE_OAUTH_TOKEN`, `:51`) stays. A pin cannot remove
  it. No setup mode for Codex bypasses the binary or the environment (unlike
  t3code's `setupMode`).

### 6.5 Provider and model allowlists

- **Backstop:** `checkRun` in `AgentRunner.run` checks the provider and the final
  model, explicit or routed.
- **Routing.** `providerAvailableForProject` (`provider-availability.ts:9`) returns
  false for a provider that is not allowed. Auto routing (`run-launcher.ts:236-285`)
  considers only allowed providers and models.
- **Refused:**
  - `switchSessionAgent`, `acceptPlan` with a provider, and `queueProviderSwitch`;
  - saving an automation or a webhook that names a provider or model that is not
    allowed.
- **Left out:**
  - `start_session`, `delegate_task` and `listAgentTargets`;
  - the text-generation, writing and review resolvers (`host/settings.ts:241/251/294`,
    `guide-warmer.ts:80`). When nothing is allowed, they report "unavailable".
- **Marked for pickers.** `enrichAgentMetadata` (`session-handlers.ts:165`) marks each
  provider and model that is not allowed, with the reason. This includes custom
  models (`provider-runtime.ts:70/160`).

### 6.6 Settings locks

- **Session settings.** `applySettings` runs:
  - where the host decodes a request's `executionPreferences` and `ctx.settings`
    (`run-input.ts:54/63`);
  - where it reads stored preferences for automations, tasks and webhooks.

  Locked keys replace what arrived. The person's stored settings do not change.
- **Host settings.** `getHostConfig` applies `applyHostSettings`. `setHostConfig`,
  `configUpdate` and the agent config tool (`config-tools.ts:173/180`) refuse a locked
  key with `SETTING_MANAGED`.

### 6.7 Network exposure

**`host.remoteAccess: false`:**

- **Bind.** `resolveEffectiveServerOptions` (`transport/bind-policy.ts:5`) returns
  `127.0.0.1`, whatever the options and the `SOLUS_HOST` variable say. A host or a
  `SOLUS_HOST` that is not loopback refuses to start with
  `REMOTE_ACCESS_NOT_ALLOWED`. This runs before the listener starts
  (`boot-server.ts:414`, `:1677`), so a refused configuration never listens.
- **Rebind.** `connectionsSetRemoteAccess` (`connections-handlers.ts:169`) and
  `rebind()` (`boot-server.ts:1745`) refuse to open the bind.
- **LAN discovery** does not start (`boot-server.ts:1728`).
- **Pairing.** `connectionsGeneratePairToken` (`connections-handlers.ts:152`) and
  pair links (`apps/desktop/src/main/pair-url.ts:48`) are refused. Doors run with
  `pairingDisabled` (`admission/doors.ts:126`).
- **Paired devices.** Tokens of devices paired from off the machine are rejected
  (`auth.ts:195`), and the list shows them as signed out by policy.
- **Host introductions** (`connections-handlers.ts:179-201`) are refused.

**`host.trustLocalNetwork`:** this lock forces `trusted-requesters.ts:30`.
`connectionsSetTrustLocalNetwork` (`connections-handlers.ts:174`) refuses a change.

**`host.cloudTunnel: false`:**

- `uplinkLink` is refused (`uplink-handlers.ts`).
- A stored link does not resume (`link.ts:233`).
- An active link is closed when the policy arrives.
- Registration with Solus Cloud (`uplinkRegister`) still works, because the host
  needs its standing to get cloud policies. Registration is outbound only.

**Not covered:** Tailscale. Solus only reads its status (`endpoints.ts`). A user can
still forward the loopback port with other tools. The docs say this.

### 6.8 Updates

**`host.updates.mode: 'off'`:**

- The desktop app does not check for updates (`apps/desktop/src/main/updates/ipc.ts:186`),
  and its check, download and restart IPC (`:169-173`) report `UPDATES_MANAGED`.
- The host refuses `hostCheckForUpdates` and `hostInstallUpdate`
  (`boot-server.ts:1065-1068`).
- `solus update` refuses (`apps/cli/src/lib/update.ts`).

**`host.updates.feedUrl`:** the desktop app updates from this generic feed instead of
`https://releases.solus.sh` (root `package.json:160-162`), through
`autoUpdater.setFeedURL`. The standalone server keeps its GitHub source. Its
installation is pinned with the organization's package tooling, and the docs say
this.

### 6.9 Insights and webhooks

- `insight-mirror.ts:43` reads `syncAllInsights`. The rule order is: never `local`;
  always on an attached machine shared with the organization; then the policy; then
  the host's opt-in.
- `receiver.ts:156` and `webhook-service.ts:140` read `allowsUnverifiedWebhooks`. An
  MDM policy that sets it also covers `local` webhooks.
- `unattendedOrganizationRefusal` keeps its `allowsPersonalHosts` check from the host
  rules. It also runs on each delivery, not only on save.
- `HostOrganizations.policyFor` and `DEFAULT_ORGANIZATION_POLICY` are deleted.

## 7. Clients and the CLI

- **Summary.** A new RPC `hostPolicy` and the event `host.policyChanged` give:
  - the MDM summary;
  - the host-owning organization;
  - for each organization: its host policy and organization policy, or an
    `unavailable` / `unenforceable` state.

  They are loaded as a new `policy` fact in `host-facts.ts`. The summary holds no
  launch pins and no feed URL, because those can carry tokens.
- **One resolver.** `packages/client-core/src/policy.ts` has `resolveSession` and
  `resolveHost`. Desktop, web and mobile all use it.
- **Locks:**
  - **Session pickers** (mode, model, provider) lock for the work's organization.
    Modes, providers and models that are not allowed are disabled, with the reason.
  - **The default mode** of a new tab is clamped. Desktop and web:
    `session.factories.ts:31`, `session-config.svelte.ts:114`,
    `session-plan-operations.ts:193`. Mobile: `AgentDefaultsScreen.tsx:72`.
  - **Settings pages** show a line under each managed key, for example "Globex
    sessions use Opus". A key from the MDM policy is locked everywhere on the host.
  - **Host settings**: each `host` key is locked and names its source. This covers
    remote access, local network trust, the cloud tunnel, pairing, analytics and
    updates.
  - **The provider instance editor** locks the fields the policy owns.
  - **The update UI** says "<Name> manages Solus updates." when the mode is `off`.
  - **Refusal copy** covers the codes of §6.1, in `turn-refusal-copy.ts` and on
    mobile.
- **Policy editor** (desktop and web, Settings → Policy):
  - Owners edit the organization policy and the host policies.
  - Owners assign host policies from the organization's host list. A host owned by
    another organization shows that organization's name, and only a host policy
    without `host` can be assigned to it.
  - Anyone can build a document.
  - **Export** gives `policy.json`, `com.solus.app.mobileconfig` (a device payload for
    the domain), and `Set-SolusPolicy.ps1` (one line of JSON into the registry
    value). It is a pure function in `packages/client-core/src/policy-export.ts`.
  - **Import JSON** validates the document and shows the difference.
  - On an MDM host, the policy is shown read-only, with **Copy as new**.
  - The Insights switch in `SettingsTabOrganization.svelte`, `organization-draft.ts`
    and mobile `OrganizationSettingsScreen.tsx` is removed. `organization-rows.ts`
    reads the resolver.
- **Mobile:** a read-only Policy screen, and every lock. This is a platform exception
  that needs approval (§11).
- **CLI** (`apps/cli`):
  - `solus policy check <file>` runs the validator and prints what the policy does.
  - `solus policy show` prints:
    - the installed MDM source and its fingerprint;
    - whether the running host loaded the same fingerprint ("Restart Solus to apply
      the installed policy" when it did not);
    - the cloud policies the host holds, with their revisions.

## 8. Ordered work

1. **Contracts:** `policy.ts` (the schema, the validator, the key tables, the
   summary, the codes, the fingerprint); the `hostPolicy` RPC and event; the standing
   fields. Remove the old organization policy and settings schemas.
2. **Cloud:** the tables, the API, ownership of the host section, the audit events,
   the template, the standing.
3. **Host:** `mdm-policy.ts` (all three sources), the standing cache, `policy-gate.ts`.
4. **Enforcement:** §6.3 to §6.9.
5. **Desktop main:** the MDM read before boot, analytics and updates (§5.4, §6.8).
6. **Clients:** the `policy` fact, the resolver, the locks, the refusal copy, the
   editor and the export, on desktop, web and mobile.
7. **CLI:** `solus policy check` and `solus policy show`.
8. **Docs:**
   - `docs/managed-policy.md` for administrators: the three sources, rollout, where
     the MDM policy goes, every key, refusal to start, and §10;
   - rewrite `docs/settings.md` §"Organization settings";
   - a note on plan 018 decision 7;
   - a row in `plans/README.md`.

## 9. Tests

All tests are in `tests/unit/`. Each one names the rule it protects.

- `policy-document.test.ts`:
  - unknown or unmanageable keys are refused;
  - `host` is refused in an organization policy;
  - each rule that crosses keys;
  - an absent key means no rule;
  - the export round trip (JSON → mobileconfig payload → JSON, and the PowerShell
    value);
  - the fingerprint is stable when key order changes.
- `mdm-policy.test.ts`:
  - each source;
  - two sources refuse;
  - a bad document refuses, and the message names the source;
  - a release build ignores the dev override.
- `policy-gate.test.ts`:
  - work of organization A never sees organization B's policies;
  - order: MDM, then the host policy, then the organization policy;
  - `local` work sees only MDM;
  - host keys: MDM, then the host-owning organization, then the stored value;
  - `POLICY_UNAVAILABLE` and `POLICY_UNENFORCEABLE`;
  - the cache applies after a restart with no network.
- `permission-ceiling.test.ts`:
  - every path of the inventory is refused above the ceiling at the backstop;
  - the clamp points lower the mode;
  - a steer above the ceiling is refused;
  - an old session is refused until a lower mode is sent;
  - Claude suggestions above the ceiling are removed.
- `provider-launch-policy.test.ts`:
  - under a ceiling, the user's launch fields do not reach the launch, on both early
    returns too;
  - pins apply;
  - writes to owned fields are refused, and the stored values survive.
- `provider-model-allowlist.test.ts`:
  - the backstop catches explicit and routed models;
  - routing chooses only allowed models;
  - switches are refused;
  - automation and webhook saves are refused;
  - the agent targets filter;
  - a resolver with nothing allowed reports "unavailable".
- `settings-locks.test.ts`:
  - session locks apply only to their organization's work;
  - background work gets the lock when it runs;
  - the stored settings do not change;
  - host locks overlay `getHostConfig` and refuse writes;
  - `OTEL_EXPORTER_OTLP_*` is ignored under an `otel` lock.
- `network-policy.test.ts`:
  - with `remoteAccess: false`, the bind is loopback whatever `SOLUS_HOST` says, and a
    host that is not loopback refuses to start;
  - rebind, pairing, pair links and host introductions are refused;
  - old paired tokens are rejected;
  - LAN discovery does not start;
  - with `cloudTunnel: false`, link is refused, a stored link does not resume, and
    registration still works.
- `update-policy.test.ts`:
  - with `mode: 'off'`, the desktop checks nothing, and the host and CLI update paths
    refuse;
  - `feedUrl` reaches `setFeedURL`.
- **Updated:**
  - `insight-mirror.test.ts`;
  - `webhook-receiver.test.ts` (a personal-host check on each delivery);
  - `webhook-service.test.ts`;
  - `host-organizations.test.ts`;
  - `settings-resolution.test.ts` (replace the decision 7 guard);
  - `turn-organization.test.ts`;
  - the client tests for the pickers, the locks, the resolver and analytics off.
- **Cloud:**
  - policy writes: owner only, conflict, validation, audit;
  - assignment: one for each organization and host, shared or managed hosts only,
    deleted on unshare;
  - ownership of the host section: first owner wins, a second `host` is refused,
    and it is released on removal.

## 10. Not covered, and when to stop

**A policy does not cover:**

- **A ceiling is not a sandbox.** Claude Code reads `~/.claude/settings.json` and the
  project settings (`claude-agent.ts:339`). Allow rules and hooks there can approve
  tools. Use Claude Code's managed settings for those. Codex is the same with its own
  config.
- **A locked instruction is not a security boundary.**
- **A user with administrator rights can remove an MDM policy.** A Solus version from
  before this plan ignores it. Use the MDM tool's application controls to choose
  which builds run.
- **The host process environment reaches providers.**
- **Without remote access**, a user can still forward the loopback port with other
  tools.
- **A web client** that opens a remote host keeps its own analytics choice.
- **The standalone server updates from GitHub.** Pin it with package tooling.

**Stop and ask** when:

- Claude text generation cannot run below `full-access`.
- A path starts provider work without passing `AgentRunner.run`.
- A reader of a manageable setting cannot be routed through `applySettings`.
- `reg.exe` or `plutil` cannot be used to read the native sources on a managed
  machine.

## 11. Open decisions

- **O1. Mobile is read-only for policy.** Editing and export are desktop and web
  tasks. Mobile shows the effective policy and every lock. This is a platform
  exception and needs approval.
