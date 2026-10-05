# Plan 018: Sync personal settings and enforce organization settings

## Status and purpose

- Status: IMPLEMENTED in both working trees and not committed. Organization scope was
  narrowed on 2026-10-03 (decision 7): organizations can enforce only Sync all Insights.
  The rule sections below that name permission mode, task lifecycle, or disabled
  tools are kept as history. They are not implemented. `docs/settings.md` describes the
  current behavior.
- Date: 2026-10-03.
- Priority: P1. Effort: L. Risk: high at the execution and identity boundaries.
- Baseline: Solus `cb9ecc5fc`; solus-cloud `5a67a73`, plus both current working trees.
- Dependencies: current account, organization, and record authority from plans 009,
  010, 012, and 013; native client work from 017. Do not duplicate those systems.
- Owners: `~/solus` owns contracts, clients, and host enforcement.
  `~/solus-cloud` owns account settings storage and organization settings storage,
  authorization, administration services, and audit records.

A signed-in user can enable personal settings sync and carry supported preferences
between desktop, web, and native mobile. Organization owners can set required values
from Settings in each client. Members see which values their organization controls.
Turning personal sync off must not turn organization rules off.

This is a design and implementation plan, not permission to deploy or migrate a live
database. Preserve other work in both working trees. No application code changed when
this plan was prepared.

## 1. Product decisions

Decision 1 is approved by the user. Decisions 2–6 are proposed implementation choices.

1. **Organization scope — approved:** apply rules to work whose durable `organizationId` names
   that organization. Do not apply one organization's rules to Local work or another
   organization. The workspace filter is not execution authority. The user confirmed
   “Organization work only” on 2026-10-03.
2. **Sync consent:** sync is off by default. A user enables it on each client install
   or browser profile, for one account and cloud origin. Signing in alone never starts
   uploads. An enabled client joins that account's one shared preference profile.
3. **Permissions:** use the current owner/member system. Owners can edit organization
   settings; members can read the rules that apply to them. Return a server-computed
   `canManageSettings` capability. Do not create a new administrator role or role editor.
4. **First release:** organization rules are either `inherit` or `enforced`. Do not add
   a third organization-default tier, group rules, or per-project policy exceptions.
5. **Device differences:** sync portable intent, such as `themeMode: system`; resolve
   native appearance, fonts, and supported controls on each client. Keep zoom, OS
   permission grants, global shortcuts, credentials, and window geometry local.
6. **Governance timing:** check fresh rules before a new turn, resume, queued dispatch,
   or privileged tool action. A policy edit does not undo completed work. An active
   provider that cannot adopt a stricter rule must stop safely before further governed
   actions. Do not advertise an enforcement guarantee that a provider cannot satisfy.

7. **Organization scope — approved 2026-10-03:** not every setting can be enforced by
   an organization. An organization can enforce only a setting with a real enforcement
   point. For now that is only Sync all Insights. Remove the new `permissionMode`,
   `agentTaskLifecyclePolicy`, and `disabledSolusTools` rules, their host enforcement,
   and their UI. Clients can change only `syncAllInsights`. Host eligibility and
   provisioning defaults stay in the cloud console. Decisions 4 and 6 and the new
   rules in §3.4 are replaced by this decision.

8. **No compatibility — approved 2026-10-03:** Solus has no end users. Remove the
   migrations and compatibility paths in this plan: the legacy client blob import, the
   analytics consent migration, the mobile appearance migration, the host import offer,
   legacy automation snapshots, legacy `server-settings.json` keys, `seeded` host
   config, and lenient execution preferences. `HostConfig` holds host keys only.
   Personal settings own their schemas. Keep the committed database migration history,
   so existing development databases keep working. Fold the uncommitted plan 18
   migrations into one migration per database. The migration steps in §3.5 and Stage 4
   are history.

Keep decisions 1, 7, and 8 fixed during implementation. The other proposals make the plan
concrete and can be changed during review.

## 2. Current state and evidence

Paths below are relative to Solus unless prefixed with `solus-cloud/`.

| File | Current behavior and consequence |
| --- | --- |
| `packages/contracts/src/host-config.ts` | `HostConfig` mixes appearance, agent defaults, instructions, and operator settings. It includes host paths and OTEL headers. It is not safe to upload this object as a user profile. |
| `packages/server/src/host/settings.ts` | Persists `server-settings.json`; `getHostConfig` and `setHostConfig` read and patch one host-wide object. |
| `packages/server/src/transport/handlers/settings-handlers.ts` | `configGet` and `configUpdate` read/write that object; the change callback broadcasts it. The update also changes live OTEL and rate-limit behavior. |
| `packages/server/src/admission/access-policy.ts` | Includes `configUpdate` in privileged host operations. Personal sync must not require host administration or expand that privilege. |
| `packages/workspace-ui/src/contexts/app/settings.context.svelte.ts` | Caches settings in `solus-settings`, adopts or seeds a host, then sends debounced host patches. Host switching can therefore change personal choices. |
| `packages/workspace-ui/src/components/settings/SettingsPage.svelte` | Combines global-looking panels and explicitly selected-host panels. New Personal and Organization pages must work without a connected host. |
| `apps/mobile/src/features/settings/host-settings.ts` | Native store reads and updates host config and subscribes to `config.changed`. |
| `apps/mobile/src/features/settings/appearance.ts` | Native appearance is a separate device preference. Add it to opt-in sync while preserving its existing value during migration. |
| `packages/client-core/src/cloud-account.ts` | Web account calls use a same-origin cookie. This is not a desktop/native transport. |
| `apps/desktop/src/main/account/account-session.ts` | Main process holds the account session; `cloudRequest` adds its credential. Do not expose that credential to the renderer. |
| `apps/mobile/src/features/account/account-client.ts` | Native calls use the account session as a bearer credential. |
| `packages/server/src/host/organizations.ts` | Reads cloud organization standing every five minutes; `policyFor` can fall back to defaults. That fallback must not authorize work under missing new governance rules. |
| `packages/server/src/execution/agents/run-input.ts` | UI runs read user instructions from context; background runs read host instructions. Both paths need explicit settings ownership. |
| `solus-cloud/src/lib/server/organizations.ts` | `roleIn` reads current membership; roles normalize to owner or member. |
| `solus-cloud/src/lib/server/host-policy.ts` | Stores existing host policy, checks owner permission, and records changes. Reuse these rules and storage; do not create duplicate host-policy values. |
| `solus-cloud/src/routes/(signed-in)/organizations/[organizationId]/organization.remote.ts` | Existing console settings call `saveHostPolicy`. Client administration and console administration must call the same domain service. |
| `solus-cloud/src/lib/server/uplink/v1.ts` | `requireAccountSession` accepts account cookie or bearer credentials and checks cookie writes for CSRF. |
| `solus-cloud/src/server/routing.ts` | New account-plane `/v1` routes must be in `SITE_API_ROUTES`; otherwise the record service receives them. |

Current excerpts for drift checks:

```ts
// packages/server/src/transport/handlers/settings-handlers.ts
server.register('configGet', () => getHostConfig())
const parsed = hostConfigPatchSchema.parse(patch ?? {})
const snapshot = setHostConfig(parsed)

// packages/server/src/execution/agents/run-input.ts
rateLimitBehavior: getHostConfig().config.rateLimitBehavior,
extraInstructions: settings.extraInstructions,

// solus-cloud/src/lib/server/host-policy.ts
const role = yield* Effect.promise(() => roleIn(db, callerUserId, organizationId));
if (role !== 'owner') return yield* Effect.fail(new NotPolicyOwner());
```

The host-config header says some operator settings are separate; the interface and
handler now include them. Use the current interface and tested handler behavior as the
baseline. Correct that header during the split. Its reference to
`docs/plans/config-overhaul.md` points to a missing file in this checkout; do not use it
as a second source of truth.

The settings context has 881 lines and SettingsPage has 661 lines at this baseline.
Keep new sync and policy logic in focused modules. Do not expand either past 1,000 lines.

## 3. Settings ownership and precedence

Use an explicit typed field inventory. Every existing `HostConfig` field must have an
owner, migration rule, client capability, and governance eligibility. New keys must fail
an exhaustive test until classified. Do not derive eligibility from value shape or from
all keys in `HostConfig`.

### 3.1 Complete field inventory

This inventory was checked against all **54 `HostConfig` fields** and all **13
`DEVICE_FIELDS` entries** on 2026-10-03. It replaces the earlier broad grouping in this
plan. These are proposed target owners, not claims about current storage. Personal
means a local personal profile when sync is off and the same profile synced to the
account when enabled. Device and Host values do not enter personal sync. Organization
rules stay cloud-owned and apply only to that organization's work.

The table uses the current field names so the migration can account for each one.
Only the organization rules in §3.4 are enforceable in V1; assigning a field to Personal
does not automatically make it organization-managed or agent-writable.

| Current `HostConfig` field | Target owner | Reason and migration rule |
| --- | --- | --- |
| `solusTools` | Host | Base operator tool availability. Keep host denials; combine with organization denials. No personal enable can undo either. |
| `themeMode` | Personal | Sync light/dark/system intent. System resolves on each device. Import native appearance into the same personal key. |
| `voiceModeEnabled` | Device | Enables this client's voice interaction. Keep off/on choice with the device and its microphone support. |
| `autoSendVoiceTranscripts` | Device | Controls automatic sending from this microphone workflow. Do not enable automatic sending on another device through sync. |
| `vadSilenceMs` | Device | Timing depends on the microphone and environment. |
| `defaultEditor` | Device | Current launch callers require the client machine. Keep the local application choice; installed editors are capability data. |
| `fallbackTerminal` | Device | The terminal resolver and launch guards require the client machine. Never apply this value to a remote host. |
| `activeAgent` | Personal | Preferred provider for new work; availability remains a host capability. |
| `defaultPermissionMode` | Personal | Personal default for new sessions. An organization `permissionMode` rule can override and lock the effective mode. |
| `notifications` | Personal | Sync each `channels` and `events` preference. OS permission and delivery availability remain device state. |
| `modelRouting` | Personal | The `ui`, `general`, `exploration`, and `structured` model choices follow the person. Resolve availability at execution. |
| `defaultModels` | Personal | Per-provider defaults for the person's new work. |
| `modelOptionsByProvider` | Personal | Per-provider/model `reasoningEffort`, `contextWindow`, and `fastMode`. Preserve unavailable choices without changing them on sync. |
| `handoffHistoryTokens` | Personal | How much context the person's handoff should use. Capture for the operation. |
| `continueSessionsAfterHostRestart` | Host | Host lifecycle/recovery behavior. Preserve the managed-host prohibition. |
| `reviewAgent` | Personal | Preferred review provider. |
| `reviewModel` | Personal | Preferred review model. |
| `reviewReasoning` | Personal | Preferred review effort. |
| `reviewGuideInstructions` | Personal | User-authored guidance; never automatically writable by an agent. |
| `savedLenses` | Personal | User-authored review presets: `id`, `name`, `prompt`. Preserve IDs; treat the array as one conflict unit in V1. |
| `generatePrGuidesOnOpen` | Personal | Whether the person's open action starts a guide. |
| `reviewWarmingByProject` | Host | Existing map names absolute project paths and enables background work. Keep it explicitly keyed by host and project path. Do not upload it as a portable project preference. |
| `responseStreamingMode` | Personal | Preferred response delivery. The server currently reads it during streaming; capture it for each run so a second client's setting cannot change that run mid-stream. |
| `rateLimitBehavior` | Personal | The person's response to rate limits; carry into the run and queue. Do not read a process-wide setting when a queue drains. |
| `autoRenameSessions` | Personal | Default for the person's session creation. Capture the decision for background title work. |
| `showToolCalls` | Personal | Transcript presentation. |
| `showDiffSummaryAfterTurn` | Personal | Transcript presentation. |
| `collapseComposerWhenIdle` | Personal | Composer preference. |
| `fontFamily` | Personal + Device override | Sync bundled preset/sentinel only. Preserve an installed-only family as a local override. |
| `fontSize` | Personal | Preferred text size, separate from device zoom and OS accessibility scale. |
| `codeFontFamily` | Personal + Device override | Same preset/local-family rule as interface font. |
| `codeFontSize` | Personal | Preferred code text size. |
| `documentFontFamily` | Personal + Device override | Sync preset or `solus`; keep installed-only family local. |
| `documentFontSize` | Personal | Preferred document text size. |
| `promptFontFamily` | Personal + Device override | Sync preset or `interface`; keep installed-only family local. |
| `promptFontSize` | Personal | Preferred prompt text size. |
| `fontSmoothing` | Device | Rendering option only supported by some engines; not a portable visual preference. |
| `assistantTextOpacity` | Personal | Reply contrast preference within existing minimum bounds. Never subject to organization lock. |
| `extraInstructions` | Personal | Person's instructions for future work. Capture relevant text for background operations; preserve agent-write prohibition. |
| `modelInstructions` | Personal | Person's model-specific instructions. Same authority and capture rule as extra instructions. |
| `analyticsEnabled` | Split: Device + Host | Replace with separate `clientAnalyticsEnabled` and `hostAnalyticsEnabled`. Current key gates two distinct emitters. Neither is part of personal sync or organization policy. |
| `tabGroupMode` | Personal | Preferred grouping, not the current tabs or navigation state. |
| `archivedAutomationRetentionDays` | Host | Scheduler deletes persisted archived automations. This is data retention, not a personal list display option. |
| `sidebarCompletedRetentionDays` | Personal | How long completed tasks appear in a personal sidebar shelf; does not authorize data deletion. |
| `sidebarMotionMs` | Personal | Preferred finite motion duration. Device reduced-motion preference can further reduce motion. |
| `leadModel` | Personal | Default provider/model/effort for a new task lead. Capture on the task; existing tasks do not change when a user changes the default. |
| `agentTaskLifecyclePolicy` | Personal | Person's chosen task autonomy, with an organization rule applied to organization tasks. Preserve existing agent-write prohibition. |
| `leadInstructions` | Personal | Person's task lead guidance, not a machine property. Capture on new task work and keep agent-write prohibition. |
| `workerModel` | Personal | Default model/effort for the person's workers. Resolve with task context, not the host owner's preferences. |
| `otel` | Host | `enabled`, `endpoint`, `headers`, `exportMetrics`, `exportTraces` configure the host exporter. Keep secret headers out of personal/cloud preference payloads and member policy responses. |
| `textGenerationModel` | Personal | Preferred model for titles and other writing done for the person. Host installation and provider seat remain separate capabilities/authority. |
| `sourceControlWriterModel` | Personal | Preferred commit/PR writer; null falls back to that person's `textGenerationModel`, not another user's host setting. |
| `sourceControlWriting` | Personal | `mode`, `customInstructions`, `followPullRequestTemplate` express the person's writing choices. Preserve the existing repository-conventions behavior. |
| `worktreeBranchNaming` | Personal | `mode`, `prefix`, `template` are a naming preference. Preserve the existing project `.solus/config.json` override, and capture effective naming when the worktree is created. |

Fonts are a deliberate split of intent and local override, not an untyped union of
stores. Add four optional device override keys for the font families, with an explicit
“Use synced font” action that removes an override. The personal keys accept a bounded
list of built-in presets/sentinels; an unsupported preset uses a local fallback without
writing it back. Show when a device override masks a synced preference.

Analytics needs an explicit two-emitter migration. Keep each host's old value as
`hostAnalyticsEnabled`. Seed `clientAnalyticsEnabled` from that client's existing
cached value. If either existing relevant source records an opt-out, do not turn the
client on during migration. If consent cannot be established, leave that emitter off
until the user chooses. No account import or sign-in may grant consent. Update the
legacy `setAnalyticsConsent` path so it cannot change both emitters by accident.

### 3.2 Device fields, server fields, and capability state

All existing `DEVICE_FIELDS` entries stay on the device and remain out of account sync:

| Device field | Meaning |
| --- | --- |
| `zoomFactor` | This client's zoom |
| `typographyAdvanced` | Whether advanced controls are expanded |
| `keybindings` | Per-device shortcut overrides, including disabled bindings |
| `projectPanelOpen` | Current pane visibility |
| `splitProjectPanelOpen` | Current companion pane visibility |
| `projectPanelWidth` | Local pane geometry |
| `splitProjectPanelWidth` | Local companion pane geometry |
| `projectPanelCollapsed` | Local section expansion state |
| `splitProjectPanelCollapsed` | Local companion section expansion state |
| `sidebarProjectFilter` | Current local view filter |
| `lastProject` | Recent `{serverId, directory}` navigation target |
| `lastChatServerId` | Recent local connection choice |
| `onboardingCompleted` | This client's onboarding state; distinct from cloud account onboarding |

Do not infer a new pane vocabulary from the legacy `split*` field names. Keep the
canonical pane model when these fields are consumed.

Additional fields already owned by `ServerSettings` stay scoped to the host:

| Field | Target treatment |
| --- | --- |
| `remoteAccess` | Host network control; operator only |
| `trustLocalNetwork` | Host admission control; operator only |
| `metricsRetentionDays` | Host data retention |
| `projectsBaseDirectory` | Host filesystem path; never sync to the account |
| `insightsOptInOrganizationIds` | Host-scoped opt-in for that machine's delivery to named organizations. Preserve organization policy precedence and existing authority; no global personal toggle. |
| `hostConfig` | Legacy container to narrow during migration, not a user setting |
| `hostUser` | Host identity/adoption record, not a setting editable in the settings form |

Native `AppearancePreference` becomes an adapter to the personal `themeMode` value.
Use its existing local choice as migration input; do not keep a second independent
synced theme. OS appearance, OS reduced-motion/text scaling, notification permission,
microphone permission and downloaded model state remain device/host capability state.

Provider login, API keys, OAuth tokens, TypeSafe credentials, OTEL header secrets,
installed editors/terminals, code-intelligence packages, and voice model downloads are
not portable user preferences. Retain their existing vault/install owners. A Settings
page may expose these operations without adding them to any generic settings patch.
Likewise, account onboarding, membership, connected hosts, project records, and a
session's model/permission overrides keep their existing domain owners.

### 3.3 Evidence for the choices that change ownership

- `execution/session-runtime.ts` reads task lifecycle, lead instructions and worker
  model from `getHostConfig()` when it starts lead work. `execution/agents/tools/task-tools.ts`
  also reads host lifecycle policy. These describe whose task is being performed, so
  both paths must receive the task's captured personal preferences and current policy.
- `execution/sessions/session-title.ts` and `git/worktree-name.ts` select the writing
  model through `resolveTextGenerationModel`. `transport/handlers/worktree-handlers.ts`
  already has `handlerCtx.actor` and a person-bound provider seat, but reads host-wide
  writing preferences. Use that actor's operation preferences with the existing seat.
- `git/source-control-writing.ts` implements repository-conventions, conventional
  commits and custom instruction modes. Moving its input to Personal does not replace
  those modes with a new repository policy system.
- `git/worktree-branch-name.ts` resolves project config before host config today. Replace
  only the fallback with the person's captured naming preference; retain project priority.
  Keep the selected naming for later title-based renames of that worktree.
- `execution/automations/automation-scheduler.ts` uses archived retention to delete
  records. It must remain an operator setting; sidebar retention only affects display.
- `workspace-ui/src/lib/openExternalEditor.ts` and `lib/git-actions.svelte.ts` guard
  launch with `hostPolicy.isClientMachine`. `contexts/app/tools.store.svelte.ts` resolves
  the terminal through `localServerId()`. Although desktop `file-handlers.ts` executes
  a host RPC, the product action is local-device launch. Keep these guards and fix the
  settings panel's mixed selected-host/local framing; do not add remote launch behavior.
- `workspace-ui/src/lib/analytics.ts` emits client analytics, while
  `server/src/analytics.ts` gates server events with `getHostConfig().config.analyticsEnabled`.
  One setting currently couples two emitters. Separate them while preserving opt-outs.
- `contexts/app/settings.context.svelte.ts` keys review warming by project path. Keep
  its host identity explicit; the same path string on two hosts is not the same project.

Server paths in this list are under `packages/server/src/`; workspace-ui paths are
under `packages/workspace-ui/src/`. The evidence describes current behavior; the tables
above specify the intended change.

### 3.4 Organization settings

> Replaced by decision 7. The implemented organization settings document is only
> `{ syncAllInsights }` (`organizationSettingsSchema`). The rest of this section is
> history.

Organization settings are a separate rules document, not copies of the person's values.
They do not require personal sync to be enabled.

| Organization field | Status and effect |
| --- | --- |
| `allowCloudHosts` | Existing cloud policy (`allowsCloudHosts` on Uplink); controls eligible execution hosts |
| `allowPersonalHosts` | Existing cloud policy (`allowsPersonalHosts` on Uplink); controls eligible personal hosts |
| `syncAllInsights` | Existing organization delivery rule; distinct from product analytics consent |
| `defaultPackages` | Existing provisioning default for newly created managed hosts; not a retroactive install command |
| `defaultSetupScript` | Existing provisioning default for newly created managed hosts; retain owner-only editing and do not expose script contents in ordinary member policy snapshots |
| `permissionMode` | New enforced rule; overrides the person's default and validates session/turn choices |
| `disabledSolusTools` | New denial list; combines with the host's `solusTools` denials |
| `agentTaskLifecyclePolicy` | New enforced rule for organization tasks; overrides captured personal autonomy |

Keep provisioning defaults distinct from the `inherit`/`enforced` mechanism for new
rules. Reuse existing host-policy storage and owner checks. Do not introduce locked
fonts, mandatory personal sync, organization-granted analytics consent, or a policy
editor for every personal field. Model allowlists, organization writing conventions,
and organization instructions are future additions requiring their own enforcement
and precedence decisions; they are not silently included in this inventory.

V1 new enforced values:

- Permission mode for organization work. Use an explicit policy field such as
  `permissionMode`, not a locked *default* that can be bypassed per session.
- Disabled Solus tools. Organization denial and host denial combine; neither can
  re-enable the other's disabled tools. This governs Solus tools, not every command
  an external provider can run.
- Agent task lifecycle policy for organization tasks.

Retain the existing host eligibility and Insights rules in their current domain. Show
these in Organization settings beside the new rules. Other settings can become
manageable later only with an explicit enforcement path and tests. Do not claim that
prompt instructions form a security boundary. Theme and accessibility controls are not
governance controls in this release.

Resolution is per field, not one merge of all four objects:

1. Begin with the field's product default.
2. Apply the stored value from its owner: personal profile, device, or host.
3. Apply an existing project override where the domain already supports one (currently
   worktree naming), then a permitted explicit session/turn choice. A current repository
   override is not a new organization policy tier.
4. Apply the record's organization rule. A conflicting explicit request is rejected
   with the rule and organization named; defaults may resolve directly to the rule.
5. Apply host/provider capability constraints. If an enforced result is unsupported,
   refuse the operation. Do not silently pick a more permissive fallback.

Return effective value, underlying preference, source, organization, and lock reason.
Never save an enforced value back into a user's profile. Removing a rule restores their
stored choice. Account preferences are one profile across organizations; organization
rules are separate overlays. Resolve background work with the existing acting user,
not the last person to open Settings or the host owner by default.

### 3.5 Split the settings class by ownership

Keep `SettingsContext` temporarily as the UI's read interface. It must stop owning
persistence, host seeding, sync timers, and policy resolution. Do not create four large
copies of the current class or replace it with a generic inheritance framework.

| Module | Responsibility | Must not own |
| --- | --- | --- |
| Personal settings store | Validated local profile; explicit personal updates; account identity isolation | Host administration, device grants, policy writes |
| `SettingsSync` in client-core | Opt-in transfer, revisions, pending patches, conflicts and account cancellation | Rendering, CSS, host policy authority |
| Device settings store | Device keys, local overrides and consent; persistence through a client storage port | Account upload or remote host configuration |
| Host settings store | Settings and operations for an explicitly named host; reconnect and stale guards | A global current-host copy of personal preferences |
| Organization settings store | Rules/capabilities per account origin and organization; authorized drafts and saves | Final execution authorization |
| Pure effective-settings resolver | Validate precedence for an explicit context; return value/source/lock metadata | Network requests, persistence, implicit active-host or active-organization lookup |
| Server execution resolver | Load trusted policy; combine actor/record/operation inputs and host constraints | UI state or credentials from a renderer |
| Display adapters | Apply theme/font/zoom/native appearance when those values change | Sync logic, organization permission checks, durable loaders |

Use exact `PersonalSettings`, `DeviceSettings`, `HostSettings`, and
`OrganizationSettings` schemas. Field ownership and `agentWritable` are separate
properties. Moving a formerly operator-owned field to Personal must not make it
agent-writable. Configuration tools must use explicit authorized scope and must no
longer return or patch a single aggregate settings object containing secrets.

Keep one validated personal profile, not both a local authoritative profile and a
separately merged cloud profile. The cloud is its optional replica. Effective values
are derived; never persist them as another source of truth. Cache host settings by host
ID and policies by cloud origin plus organization ID. Change only affected reactive
properties so mounted conversations do not rebuild on a font or sync-status change.

Migration sequence:

1. Add types, field inventory, pure resolver, and ownership tests without changing reads.
2. Extract Device and Personal persistence; retain existing property getters as a thin
   compatibility layer. Explicit setters select their owner; remove the broad
   `update(Partial<SettingsFields>)` path after its callers have moved.
3. Connect existing focused host stores to the narrowed Host schema. Remove personal
   keys from `MIRRORED_HOST_KEYS`, `configUpdate`, host seeding, and `config.changed`.
4. Pass an explicit execution preference snapshot through task, review, title, git,
   handoff, automation and queued-run contracts. Reuse existing records; add only the
   fields required for durable background behavior. Preserve existing scheduled work
   using a one-time captured legacy preference snapshot, not a permanent global lookup.
5. Add account sync and organization store adapters. Use the same client-core sync
   engine on native and Svelte clients. Native appearance uses the personal store;
   it must not compete with the existing `AppearancePreference` writer.
6. Move display effects to a focused adapter; reduce `SettingsContext` to composition
   and compatible reads. Delete orphaned mirror code and duplicated defaults.

No new generic settings bus, global service locator, or universal key/value patch is
needed. Existing typed RPC and store subscriptions remain the transport boundaries.

## 4. Cloud records and API

Create focused contracts in `packages/contracts/src/settings.ts`, with strict write
schemas and exact named types. Do not reuse host-config schemas that heal malformed
writes to defaults. Reject unknown write keys and forbidden host/device/secret fields.
Keep schema version distinct from data revision.

Cloud storage additions in `solus-cloud/src/lib/server/db/schema.ts` and `drizzle/`:

- `user_settings`: account user FK, schema version, revision, bounded typed preference
  document, updated timestamp. Unique user key, cascade on account deletion.
- `organization_settings`: organization FK, schema version, revision, bounded typed
  enforced-rule document, updated timestamp and actor. Cascade on organization deletion.
- A small account sync generation/status record survives a profile clear. Increment the
  generation when clearing cloud settings so an offline client cannot restore deleted
  settings. Do not use timestamps from clients to resolve conflicts.

Do not add personal settings to the host mirror/outbox or replicate account secrets to
hosts. Reuse `organization_host_policy` for existing rules. Aggregate it in the response;
retain its own concurrency version if edited separately.

Proposed account-plane endpoints, owned by `solus-cloud`:

| Endpoint | Purpose and authority |
| --- | --- |
| `GET /v1/account/settings` | Read the caller's profile and revision/generation; no arbitrary user ID |
| `PATCH /v1/account/settings` | Apply a validated preference patch with expected revision/generation |
| `DELETE /v1/account/settings` | Clear cloud preferences and advance generation, with explicit user action |
| `GET /v1/orgs/:organizationId/settings` | Member reads rules, revisions, and `canManageSettings` |
| `PATCH /v1/orgs/:organizationId/settings` | Owner updates new rules using expected revision |
| `PATCH /v1/orgs/:organizationId/host-policy` | Owner updates existing host policy through its existing domain service |

Use account session validation and CSRF handling already present. On each request,
check current membership and permission; do not trust the client capability or cached
role. Nonmembers get no organization details. Host credentials cannot write account or
organization settings. Keep host policy delivery on the verified host-standing route.
If execution needs an account preference read without a client, use the existing
person-bound delegated authority with a narrow preference-read capability, not a host
credential that can enumerate profiles.

Writes use an atomic compare-and-swap revision. Return a typed conflict and current
revision on mismatch. Apply nested patches at documented field paths; reset is an
explicit operation, and `null` remains a real value where supported. Do not replace the
whole document for a single toggle. Use a transaction for organization rule write and
its audit record. Audit actor, organization, revision and changed keys; do not log user
instruction text, credentials, or full preference payloads.

Use shared public contracts through the existing package link. If Uplink standing changes,
edit its Solus source and run `contracts:sync`; never hand-edit the cloud copy. Register
new API paths in `SITE_API_ROUTES` and its tests. No import from solus-cloud into Solus.

## 5. Personal sync lifecycle

Implement a transport-neutral `SettingsSync` in client-core. Inject authenticated
request, storage, online/focus notifications, and a clock. Svelte and React Native use
adapters over this same state machine; they must not each implement conflict rules.

States: signed out, off, loading, synced, pending, offline, conflict, and error. Expose
last confirmed sync time. Never label an optimistic local edit as synced.

- Local profile and consent keys include cloud origin and account user ID. Anonymous
  preferences have a separate key. On account switch, cancel work and invalidate late
  responses before showing the next account. Never upload the previous user's queue.
- First enable reads cloud first. If absent, offer the current portable preferences as
  the seed, show the source, and create with an expected absent revision. If present,
  offer “Use synced settings” by default or an explicit “Replace with this device”. Do
  not upload a host snapshot or silently overwrite an existing account profile.
- Allow immediate local edits. Coalesce changes, keep a bounded durable pending patch,
  and send after the user stops editing. Keep base values/revision for three-way merge.
- On conflict, merge unrelated field paths and retry against the new revision. For the
  same changed field, show both choices and keep a visible conflict until resolved.
  Bound retries. Arrays such as saved lenses are one conflict unit in V1.
- Use revision-based refresh at launch, focus, reconnect, Settings open, and a 60-second
  timer while foreground and online. One coordinator per client, not per mounted tab.
  Broadcast confirmed changes between browser tabs. Stop timers when off or signed out.
  Organization execution checks have stronger freshness rules than this UI refresh.
- “Turn off on this device” cancels future transfers, leaves confirmed portable values
  as local preferences, and leaves the cloud profile and other devices alone. In-flight
  writes may already have committed; report their result without restarting sync.
- “Clear synced settings” is a separate online action. It advances the cloud generation.
  Other clients discard old-generation uploads and turn sync off when they next connect.
  A first re-enable must use the new generation. Explain any unsent changes before clear.
- Sign-out stops sync and removes the account's active preference/cache view and pending
  uploads. Ask about unsent changes through the existing discard flow. Restore the
  anonymous profile; do not copy account instructions into it.
- Unsupported fonts/models retain their stored intent. Use a local fallback and show
  why; never upload that fallback as a new user choice. OS notification permission and
  actual provider availability are capability state, not synced preferences.

## 6. Host enforcement and background work

Add a focused effective-settings resolver near execution, with pure resolution logic
in contracts where clients need the same explanation. Do not put policy storage or
sync scheduling in `SessionRuntime`.

Use the persisted record organization and authenticated acting user. Client-supplied
organization IDs or policy snapshots are hints only. Personal preferences can supply
choices; only trusted cloud policy can supply authority.

Extend verified organization standing with policy revision and enforced rules. Replace
permissive missing-policy fallbacks for governed operations. Before a new organization
turn or resume, fetch/validate current policy. Deduplicate simultaneous fetches. If the
control plane cannot validate it, reject new governed execution with a retry state;
Local work remains usable. Cached policy can explain a disabled control, but cannot
authorize new work after freshness is lost.

At active tool boundaries, apply current denials. Notify running sessions when policy
changes. For permissions delegated inside Claude or Codex, prove the adapter can update
or interrupt execution before claiming live enforcement; otherwise stop and require a
new turn under the current revision. State the limit that an already dispatched action
cannot be recalled. Hosts are trusted enforcement points: this does not control an
administrator running a modified Solus binary outside the organization service.

Route all these paths through the resolver:

- Interactive start, follow-up, resume, fork, and per-session permission changes.
- Queued prompts at actual dispatch, not only at enqueue time.
- Tasks, worker/subagent sessions, automations, handoffs, and background reviews.
- Agent settings tools, direct RPC, and HTTP entry points.

Capture personal execution preferences when creating scheduled/background work so it
has defined behavior while the client is absent. Store only the relevant validated
fields with its existing acting-user context. Existing schedules keep a migration snapshot of their existing
execution preferences until edited; show this legacy source. Policy is always resolved again at run
time. Do not let sync changes silently rewrite every saved automation.

Remove global host reads for fields moved to personal ownership, with narrow searches
in their known callers. Host operator reads stay host scoped. Update title/worktree writing and task lead
callers listed in §3.3; installed-provider fallback must use the acting user's seat.
An operation with no accountable actor uses only a documented built-in service default;
it must not borrow the host owner's personal profile. Prevent old client
`configUpdate` payloads from reaching personal or enforced state after cutover; use
capability/version errors for unsupported hosts. No silent host-config fallback for
organization-governed work.

## 7. Client settings changes

Desktop and web share `SettingsPage.svelte`; native adds equivalent settings screens.
Keep the web client's one wide workspace layout.

- **Personal:** portable preferences, sign-in status, “Sync settings on this device”,
  last sync/error state, pending changes, and clear-cloud action. Works without a host.
- **Device:** device-only controls and local overrides such as an installed font.
- **Host:** selected-host operator settings; retain host admission and connection state.
- **Organization:** explicit organization picker; current rules and their source.
  Editors appear only with `canManageSettings`. Members can inspect effective rules
  without edit controls. Direct navigation must still handle forbidden/removed access.

Each governed row shows “Managed by <organization>”, the effective value, and a reason.
Keep explanation text accessible when the input is disabled. Organization owners also
see the lock in their personal controls; they edit it in Organization settings.

Organization editing uses a draft plus Save/Cancel and a revision check. Show who changed
rules, the application timing, validation errors, concurrent edits, stale status, and
permission loss. Do not queue organization writes offline. Removing enforcement is a
visible action and restores the underlying personal/host value. Existing cloud console
settings must call the same service, so either entry point yields the same state.

Update route registry, settings search, command palette, context links, keybindings and
native navigation where applicable. A host selector must not change personal settings.
An organization picker in Settings must not change another mounted session's authority.
Return focus to the active input when closing Settings and typing is the next action.
Use current light/dark tokens, keyboard controls, and accessible native interaction.

## 8. Ordered implementation stages

Read both repositories' operating instructions first. Record the initial working-tree
diff; commit hashes alone do not describe this baseline. Run scoped drift checks against
the two hashes above, and compare the current-state excerpts. Do not stash, reset,
revert, or overwrite other work. No PR or deployment is authorized.

### Stage 1 — Contract and ownership

Create `packages/contracts/src/settings.ts` and tests
`tests/unit/settings-resolution.test.ts`. Define exhaustive field ownership, portable
schemas, policy schemas, effective-source metadata, and pure resolution. Preserve the
approved organization scope in execution work. Keep host-only secrets out by type
and runtime schema. Implement the ownership split in §3.5; keep the field inventory
exhaustive against both existing tables. Add capability declarations where existing
connections expose them.

Verify: `bun test tests/unit/settings-resolution.test.ts` and
`bun run --cwd packages/contracts check` pass. Tests must fail when a newly added host
field lacks an ownership decision or a secret enters a sync payload.

### Stage 2 — Cloud storage and authorized API

In solus-cloud add `src/lib/server/settings/` with user-settings and organization-settings
services and tests; extend DB schema and generate a migration. Add the routes in §4,
route ownership, bounded validation, revision checks, generation clear, and audit writes.
Reuse `roleIn`, `requireAccountSession`, `Database`, `Audit`, and host-policy service.
Refactor the console's host-policy save only as needed to share the versioned operation.

Tests use `src/lib/server/db/pglite.ts` and its migrated disposable database. Match the
existing Effect service style in `host-policy.ts`. Never run a migration against the
configured live `DATABASE_URL` for verification.

Verify from solus-cloud: `bun run test -- src/lib/server/settings src/server/routing.test.ts`
and `bun run check` pass. If Uplink changed, run `bun run contracts:sync` then
`bun run test -- src/lib/shared/uplink.test.ts`; the copy must match Solus exactly.

### Stage 3 — Shared sync and authenticated adapters

Create `packages/client-core/src/settings-sync.ts` and
`tests/unit/settings-sync.test.ts`. Use injected ports and deterministic clocks. Add
narrow typed desktop account methods through main/preload and local-api, using
`AccountSession.cloudRequest`; do not expose an arbitrary authenticated fetch bridge.
Add cookie web and bearer native adapters using the existing account owners. Wire
account lifecycle, origin keys, cancellation, refresh, and browser-tab notifications.

Verify: `bun test tests/unit/settings-sync.test.ts` and
`bun run --cwd packages/client-core check` pass. No connected execution host is needed
to sync preferences or edit authorized organization settings.

### Stage 4 — Enforcement and migration

Add a focused resolver under `packages/server/src/execution/sessions/` and policy
validation/refresh to `host/organizations.ts`. Wire execution callers, agent tool checks,
provider permission changes, and task lifecycle behavior. Extend typed RPC/event contracts
where host clients need effective policy state, plus both transports and preload.

Migrate personal client preferences once into a versioned local profile, before sync is
enabled. Prefer the existing client cache; only offer a selected legacy host as an
explicit import source when needed. Preserve mobile appearance. Do not scan all hosts,
upload secrets, delete host files, or seed one user's cloud profile from another member's
shared host settings. Keep legacy host settings readable for rollback; new clients stop
mirroring personal edits into them. Document the minimum host version for new behavior.

Verify new `tests/unit/organization-settings-enforcement.test.ts` and
`tests/unit/settings-migration.test.ts`, then the related existing host-config,
settings-context-tiers, host-organizations, and turn-organization tests. Update tests
that encoded the old host ownership, without weakening remaining operator boundaries.

### Stage 5 — Settings UI on all clients

Add personal sync and organization feature stores beside Settings. Keep pure sync logic
in client-core, Svelte adapters in the feature, and native subscriptions in the native
app. Extend shared page navigation and native `SettingsScreen.tsx`, route types, account
integration, appearance and host-setting screens. Update existing preference consumers,
not just the settings form. Cloud console remains a second editor of the same records.

Verify focused new UI/store tests in `tests/unit/settings-sync-ui.test.ts` and
`tests/unit/native-mobile-settings-sync.test.ts` (logic and navigation tests), then
`bun run --cwd packages/workspace-ui check` and `bun run --cwd apps/mobile check`.
These checks do not prove rendered Svelte or native appearance. Arrange one explicit
integrated visual verification pass on desktop, web, iOS, and Android before completion.
Do not start a server or use computer control without the requested permission.

### Stage 6 — Documentation and release gates

Update `docs/plans/organization-scope.md`, add `docs/settings.md`, and update cloud
`docs/uplink.md` for new endpoints and source ownership. Record migration, opt-in, clear,
offline, policy freshness, unsupported hosts, and enforcement limits. Add a release gate
that requires cloud schema/API before new clients and enforcement-capable hosts before
turning on organization rules. Pin the compatible Solus contracts in the cloud release.
Do not deploy as part of this plan unless separately asked.

Verify all focused gates above and record actual results in this plan. Run lint only
on changed source paths with `bunx oxlint <changed paths>`. Root scripts currently do not
provide `lint:hosts` or `lint:types` despite older operating-manual references; locate the
current owning rule/check rather than inventing a command. Never run root `bun run test`
(it invokes a build), any build, a broad Playwright suite, or live-data verification.

## 9. Required behavior tests

Use `tests/unit/host-config.test.ts` for temporary host data; use cloud's PGlite helper
for migrations and concurrency. Test behavior through real handlers where practical.

| Area | Required proof |
| --- | --- |
| Consent | Signed-out and sync-off clients send no preference uploads; sign-in alone does not opt in |
| Isolation | Account A/origin A state and delayed responses never appear in account B/origin B |
| Sync | Two clients converge; different-field edits merge; same-field edits conflict; restart preserves pending edits; failed writes do not show Synced |
| Clear/off | Off stops future transfers; generation clear prevents stale offline resurrection; explicit re-enable is required |
| Schema | Host paths, OTEL headers, credentials, unknown keys and oversized documents are refused; malformed governance never heals to a permissive default |
| Auth | Cookie CSRF, bearer account access, wrong account, nonmember, member, owner, revoked member/owner, and host-token attempts |
| Concurrency | Two owners cannot overwrite each other silently; policy and audit persist together |
| Scope | Org A, Org B and Local sessions on one host get distinct correct values, regardless of current UI selection |
| Locks | Sync off, direct RPC, old clients, per-turn overrides, agent tools, subagents and queued work cannot bypass enforced values |
| Removal | Removing a rule restores the stored underlying value; no forced value enters personal sync |
| Providers | Claude and Codex receive and enforce the same supported policy intent; unsupported capabilities refuse execution explicitly |
| Background | Task/automation/review actor and captured preferences remain stable; current policy is checked at dispatch |
| Outage | Cached personal preferences work offline; fresh organization execution cannot use missing/expired policy as permission |
| Clients | Shared desktop/web and native expose sync, policy explanation, organization edits, errors, conflict and reverse actions |
| Capability | Local font/model fallback is never written back; notification OS grants remain local |
| Inventory | All 54 current host fields and 13 device fields have an explicit migration; adding a field without ownership fails the test |
| Task/writing ownership | Two users on one host retain different lead/worker/writer models and instructions; background work uses its captured preferences |
| Launch target | Editor/terminal choices stay device-local; remote-host selection cannot change them or enable remote launch |
| Analytics split | Client/host consent is independent; both opt-outs survive migration; sync cannot enable either emitter |
| Project behavior | Existing worktree naming override still wins; later personal edits do not rename an existing worktree differently |
| Retention | Personal sidebar retention cannot delete stored tasks or automations; archived automation cleanup still uses host retention |

## 10. Boundaries, stop conditions, and completion

In scope: contracts and their generators; settings/account client-core modules; settings
stores and immediate preference consumers; display adapters and analytics consent
split; desktop account/preload boundary; native
settings/account/navigation; host settings and organization policy; execution callers
that consume moved/governed fields; cloud settings services, DB migrations, routes,
existing organization console, audit, focused tests and documentation named above.

Out of scope: token/provider-login sync; workspace/session replication; billing;
organization role redesign; project policy inheritance; arbitrary enterprise MDM;
rewriting the account system; broad SessionRuntime refactoring; notification delivery
infrastructure; new phone layouts in web; unrelated dirty files.

Stop and report if a proposed change would break the approved organization scope, a
provider cannot enforce an offered policy, background acting-user authority is unclear,
or an existing host must accept an unverified client policy. Stop if a proposed setting
requires a new ownership model not covered here. Revise the plan rather than silently
expanding it. Existing unrelated typecheck failures must be recorded separately; do not
claim a passing gate or fix unrelated work to conceal them.

Completion requires passing focused tests and typechecks, permission and concurrency
proof on disposable data, migration proof without automatic cloud upload, and integrated
UI evidence for all clients. Record unsupported provider/host versions explicitly.
No implementation, automated test pass, visual verification, or deployment is claimed
by this planning document.

Future settings must declare ownership, sync eligibility, validation, unsupported-client
behavior, and an enforcement point if governable. Review those decisions before adding
a key to any synced or organization schema. Do not let the schemas become another copy
of the full host configuration.
