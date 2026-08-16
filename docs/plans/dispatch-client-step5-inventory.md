# Dispatch-client step 5 — deletion-sweep inventory

Generated 2026-08-14 against the working tree. 218 call sites of the
primary-host machinery step 5 deletes, each classified:
(A) host derivable in scope, (B) client-global needing an explicit
choice, (C) local-platform capability, (D) dead. Execute as one
coordinated series per docs/plans/dispatch-client.md.

# Dispatch-client step 5 — call-site audit

Working tree: `/Users/sidhu/solus` (as-is). Grouped by file; class in `()`.

---

## 1. `src/client-core` — the primitives being deleted

### `/Users/sidhu/solus/src/client-core/server-connections.ts`
- `:244` `primaryApi(): HostApi {` — **(D)** the definition itself.
- `:254` `eventsForPrimary(): HostEventSubscriber {` — **(D)** definition.
- `:309` `const resolvedId = serverId ? this.resolveId(serverId) : this.primaryServerId` — **(D)** the no-arg branch of `connectionFor`.
- `:191-201` `resolveId(serverId)` — `if (serverId === LOCAL_SERVER_ID && this.primaryServerId && !this.connections.has(serverId) && !this.targets.has(serverId)) return this.primaryServerId` — **(C)** the web `local` alias; every `resolveId(LOCAL_SERVER_ID)` site below depends on this one branch.
- `:441-446` `if (serverId === LOCAL_SERVER_ID) { … const primary = this.primaryServerId ? this.targets.get(this.primaryServerId) : undefined` — **(D)** `resolveTarget`'s mirror of the alias.
- `:407` `if (target.local || target.id === LOCAL_SERVER_ID) return true` — **(C)** identity-verification skip for the local target.
- `:161` `if (this.primaryServerId) ids.add(this.primaryServerId)` (`catalogServerIds`) — **(B)** catalog membership; should be the registered local target + saved hosts + boot host explicitly.
- `:299-306` `connectedServerIds()` — "primary first" ordering — **(B)**.
- `:348` `if (serverId === this.primaryServerId || this.retainedServerIds.has(serverId)) return` (`release`) — **(B)**.

### `/Users/sidhu/solus/src/client-core/host-policy.ts`
- `:10` `return serverConnections.resolveId(serverId) === serverConnections.resolveId(LOCAL_SERVER_ID)` — **(C)** *the* consumer of the web alias. 10 call sites of `hostPolicy.isClientMachine` ride on it: `App.svelte:1881`, `App.svelte:2295`, `InputBar.svelte:1206`, `ActionOrb.svelte:141`, `DiffPanel.svelte:149`, `DirectoryPicker.svelte:200`, `ArtifactView.svelte:64`, `MarkdownImage.svelte:32`, `git-actions.svelte.ts:190`, `openExternalEditor.ts:20`.

### `/Users/sidhu/solus/src/client-core/server-registry.ts`
- `:13` `export const LOCAL_SERVER_ID = 'local'` — **(C)**
- `:109` `if (getActiveServerId() === id) setActiveServerId(LOCAL_SERVER_ID)` — **(C)**
- `:138` `return localStorage.getItem(ACTIVE_KEY) || LOCAL_SERVER_ID` — **(C)**
- `:142` `localStorage.setItem(ACTIVE_KEY, id || LOCAL_SERVER_ID)` — **(C)**

### `/Users/sidhu/solus/src/client-core/server-connection.ts`
- `:48` `id: LOCAL_SERVER_ID,` (`localServerTarget`) — **(C)** the registered local target.
- `:60` `if (activeId === LOCAL_SERVER_ID) return localTarget` — **(C)**
- `:64` `setActiveServerId(LOCAL_SERVER_ID)` — **(C)**

### `/Users/sidhu/solus/src/client-core/session-meta.ts`
- `:6` `resolveId(serverId: string): string` / `:33` `const resolvedServerId = hosts.resolveId(serverId)` — **(A)** always called with an explicit `serverId`; alias-independent.

---

## 2. `src/renderer/App.svelte`

- `:143` `: serverConnections.primaryApi();` (`activePrScope`) — **(A)** `session.activeTabId → session.apiFor(activeTabId)`.
- `:371` `serverConnections.connectionFor()?.serverId ??` (`taskComposerServerId`) — **(A)** `tasksStore.hostForProject(taskComposer.projectKey)` is the primary expression; fallback is the vestigial arm.
- `:490` `.apiFor(LOCAL_SERVER_ID)` `.setupHostReadiness()` — **(C)** reads *this machine's* git identity as a prefill.
- `:530` `LOCAL_SERVER_ID` (`directoryPickerServerId` fallback) — **(A)** `session.sessionFor(targetTabId)?.run.serverId` / `activeSession.run.serverId`.
- `:536` `? serverConnections.primaryApi()` (`directoryPickerApi`) — **(A)** same derived id one line above.
- `:726` `isPrimary: serverConnections.connectionFor()?.serverId === serverId,` — **(B)** notification host display; reads "is this the host I'm served by".
- `:748` `const events = serverConnections.eventsForPrimary();` — **(B)** lifetime subs: `usage.limitsChanged`, plus siblings already migrated to `subscribeAllHosts`.
- `:1109` `session.activeSession?.run.serverId === LOCAL_SERVER_ID` (open-terminal keybinding gate) — **(A)**
- `:1541` `run: () => serversStore.switchTo(server.id),` — **(B)** palette "Switch server…".
- `:1860` `await serverConnections.primaryApi().takeScreenshot();` — **(C)**
- `:1868` `const serverId = run?.serverId ?? LOCAL_SERVER_ID;` — **(A)**
- `:1886` `await serverConnections.apiFor(LOCAL_SERVER_ID).attachFiles(ctx);` — **(C)**
- `:1904` `enterDesignMode()`, `:1908` `designModeReady()`, `:1909` `exitDesignMode()`, `:1926` `designModeReady()`, `:1933` `submitDesignAnnotations()`, `:1943` `exitDesignMode()`, `:1950` `exitDesignMode()` — **(C)** ×7, all desktop window capture.
- `:2118` `isLocalHost: serverId === LOCAL_SERVER_ID,` (`placeTabOnHost`) — **(A)**
- `:2283` `const serverId = run?.serverId ?? LOCAL_SERVER_ID;` (drop) — **(A)**
- `:2309` `serverConnections.apiFor(LOCAL_SERVER_ID).attachFilePaths(paths, ctx)` — **(C)**

## 3. `client/src/App.svelte`

- `:74` `serverConnections.connectionFor()?.serverId ??` — **(A)** `tasksStore.hostForProject(taskComposer.cwd)`.
- `:257` `|| !serverConnections.connectionFor()) return;` — **(B)** boot guard "is a host connected at all".
- `:259` `.apiFor(LOCAL_SERVER_ID)` `.setupHostReadiness()` — **(C)** (on web this *is* the alias).
- `:306` `LOCAL_SERVER_ID,` (`directoryPickerServerId`) — **(A)**
- `:311` `directoryPickerServerId === LOCAL_SERVER_ID` — **(A)**
- `:312` `? serverConnections.primaryApi()` — **(A)**
- `:341` `const events = serverConnections.eventsForPrimary();` — **(B)** lifetime subs.
- `:383` `isPrimary: serverConnections.connectionFor()?.serverId === serverId,` — **(B)**
- `:670` `isLocalHost: serverId === LOCAL_SERVER_ID,` — **(A)**
- `:807` `serverConnections.connectionFor()?.serverId;` (attach) — **(A)** `session.runFor(targetTabId)?.serverId`.
- `:818` `: serverConnections.primaryApi();` — **(A)** same `targetTabId`.
- `:878` `serverConnections.connectionFor()?.serverId;` (drop) — **(A)**
- `:889` `: serverConnections.primaryApi();` — **(A)**

## 4. Other `client/src`

- `/Users/sidhu/solus/client/src/lib/web-push.svelte.ts:137` `const primary = serverConnections.connectionFor()` — **(B)** builds the push-host list; `pushHostRefs(loadServers(), primaryHost)` already fans out over saved hosts, so this should be `connectedServerIds()`.
- `/Users/sidhu/solus/client/src/components/MobilePlusMenu.svelte:68` `session.activeSession?.run.serverId ?? LOCAL_SERVER_ID,` — **(A)**
- `/Users/sidhu/solus/client/src/components/ServerSetupSurface.svelte:73` `serversStore.switchTo(host.id);` — **(B)** reload-based host switch.
- `/Users/sidhu/solus/client/src/components/MobileServerSheet.svelte:37` `serversStore.switchTo(serverId);` — **(B)**

---

## 5. `src/renderer/contexts/connections/servers.store.svelte.ts` (the synthesized web local row)

- `:117` `id: LOCAL_SERVER_ID,` (desktop local row) — **(C)**
- `:122` `status: this.statusFor(LOCAL_SERVER_ID),` — **(C)**
- `:124` `} else if (this.isWebClient && this.hasPrimaryConnection) {` — **(B)** the synthesized web local row begins here.
- `:130` `id: LOCAL_SERVER_ID,` (web row labelled with the active remote) — **(B)**
- `:136` `status: this.statusFor(LOCAL_SERVER_ID),` — **(B)**
- `:143` `.filter((server) => !this.isWebClient || !this.hasPrimaryConnection || server.id !== this.activeServerId)` — **(B)** de-dupes the active remote out of the remote list.
- `:167-169` `private get isWebClient()` — **(B)**
- `:172` `return !!serverConnections.connectionFor()` (`hasPrimaryConnection`) — **(B)**
- `:180-184` `resolveHostId(serverId)`: `if (serverId === LOCAL_SERVER_ID) return this.activeServerId` — **(B)** the store-level twin of `serverConnections.resolveId`.
- `:244` `void serverConnections.probeHealth(LOCAL_SERVER_ID)` — **(C)** local `/health` for the row's machine name.
- `:333` `if (this.isWebClient && !this.hasPrimaryConnection) {` (`scanForServers`) — **(B)**
- `:343` `? serverConnections.apiFor(LOCAL_SERVER_ID)` — **(C)** desktop discovery.
- `:344` `: serverConnections.primaryApi()` — **(B)** web discovery runs on the serving host.
- `:372` `switchTo(serverId: string): void {` … `:381 location.reload()` — **(B)** the reload behaviour.
- `:379` `if (serverId !== LOCAL_SERVER_ID) touchLastConnected(serverId)` — **(C)**
- `:385` `if (serverId === LOCAL_SERVER_ID) return` (`remove`) — **(C)**
- `:418` `this.switchTo(LOCAL_SERVER_ID)` (`useLocalHost`) — **(C)**; callers: `ConnectionStatusOverlay.svelte:154`, `FatalErrorScene.svelte:73`, `ConversationView.svelte:986` — **(C)** ×3.
- `:427` `if (this.isWebClient && !this.hasPrimaryConnection && serverId === LOCAL_SERVER_ID)` (`checkReachable`) — **(B)**
- `:456` same guard in `loadProjectIdentities` — **(B)**
- `:475` same guard in `recentProjectsFor` — **(B)**
- `:519-521` `if (!this.local && this.isWebClient && this.hasPrimaryConnection && serverId === this.activeServerId) { serverId = LOCAL_SERVER_ID }` (`hostFor`) — **(B)**
- `:524` `if (serverId === LOCAL_SERVER_ID) return null` — **(C)**
- `:529` `serverId = this.resolveHostId(serverId)` (`statusFor`) — **(B)**

Other `switchTo(` callers: `/Users/sidhu/solus/src/renderer/components/servers/HostOnboarding.svelte:81` `serversStore.switchTo(store.host!.id);` — **(B)**; `/Users/sidhu/solus/src/renderer/components/servers/AddServerModal.svelte:100` `serversStore.switchTo(paired.id);` — **(B)**.

---

## 6. Renderer contexts

### `/Users/sidhu/solus/src/renderer/contexts/connections/connections.store.svelte.ts` — all **(B)**
`:66,:67,:68` `connectionsGetServerInfo/ListEndpoints/ListSessions`; `:82` `connectionsGeneratePairToken`; `:94` `connectionsSetRemoteAccess`; `:115` `connectionsSetTrustLocalNetwork`; `:131` `(target?.api ?? serverConnections.primaryApi()).getServerCapabilities()`; `:132` `target?.serverId ?? serverConnections.connectionFor()?.serverId`; `:147` `setProjectsBaseDirectory`; `:161` `(target?.api ?? …).setAgentTaskLifecyclePolicy`; `:173` `connectionsRevokeDevice`; `:183` `providerStatus`; `:197` `providerConnect`; `:213` `providerCancelConnect`; `:221` `providerDisconnect`; `:232` `eventsForPrimary().subscribe('provider.deviceCodeReceived', …)`. **16 sites.** All read/write one host's server settings + provider auth; `SettingsPage` already has `selectedSettingsHost` (`connectedServerIds()`), so these want the explicitly selected host. `:131`/`:161` already accept a `target` — only the `??` arm is the fallback.

### `/Users/sidhu/solus/src/renderer/contexts/cloudflare/cloudflare.store.svelte.ts` — all **(B)**
`:92` `cloudflareStatus()`, `:111` `cloudflareConnect(…)`, `:138` `cloudflareDisconnect()`, `:159` `eventsForPrimary().subscribe('cloudflare.connectNeeded', …)`. Cloudflare profile is per-host (deploy credentials live on the host that deploys).

### `/Users/sidhu/solus/src/renderer/contexts/app/`
- `agent.context.svelte.ts:43` `this.applyUsage(await serverConnections.primaryApi().usageLimits())` — **(B)** usage snapshots are per-host provider accounts; should iterate `connectedServerIds()` (the event path already does, via `events.subscribe('usage.limitsChanged')` at `App.svelte:755`).
- `window.context.svelte.ts:80` `await serverConnections.primaryApi().switchMode(mode)` — **(C)** guarded by `if (this.isWeb) return`.
- `tools.store.svelte.ts:36` `const serverId = serverConnections.connectionFor()?.serverId` — **(C)**
- `tools.store.svelte.ts:43` `await serverConnections.primaryApi().detectEditors()` — **(C)** editors/terminals installed on the client machine.
- `runtime-boot.ts:15` `serverConnections.primaryApi().getTheme()` — **(C)** OS dark-mode of the machine the UI runs on.
- `settings.context.svelte.ts:491` `void serverConnections.primaryApi().setAnalyticsConsent(…)` — **(C)** already gated `if (localApi.getPlatform() !== 'web')`.
- `voice-model.store.svelte.ts:21` `serverConnections.connectionFor()?.serverId === serverId` — **(B)**; `:27` `const serverId = serverConnections.connectionFor()?.serverId` — **(B)**; `:32` `primaryApi().voiceModelStatus()` — **(B)**; `:36` same — **(B)**; `:38` `primaryApi().voiceModelRetry()` — **(B)**. The store already keeps `statusByHost`; `refreshFor(serverId)` exists at `:49`.

### `/Users/sidhu/solus/src/renderer/contexts/projects/projects.store.svelte.ts` — all **(B)**
`:29` `primaryApi().listProjects()`, `:51` `primaryApi().deleteProject(path)`, `:116` `primaryApi().listRecentProjects()`. Store already has `projectsByHost` / `loadProjectsFor(serverId)` — these are the un-hosted legacy twins.

### `/Users/sidhu/solus/src/renderer/contexts/tasks/tasks.store.svelte.ts` — all **(A)**
`:170` `serverId ? apiFor(serverId) : primaryApi()` (`apiForTask` — `hostByTaskId`); `:275` (`opts?.serverId ?? this.hostForProject(cwd)`); `:395` (same, upstream); `:510` `hydrateSessionTree(sessionId, serverId?)`; `:594` `create(input, serverId?)` — `host ?? hostForProject(input.projectKey)`.

### `/Users/sidhu/solus/src/renderer/contexts/plans/plan.store.svelte.ts` — all **(A)**
`:54` `ownerServerId ? apiFor(ownerServerId) : primaryApi()` (`hostByPlanId`); `:407` `d.serverId ?? serverIdForApi(primaryApi())` (`descriptorKey`); `:443` `cachedDescriptor.serverId ?? serverIdForApi(primaryApi())`. Descriptors are stamped via `stampDescriptor(serverId, …)` at `:412`, and `loadDescriptorUnion` already iterates `connectedServerIds()` (`:454`) — the `??` arms are legacy-unstamped only.

### Other stores
- `/Users/sidhu/solus/src/renderer/contexts/works/works.store.svelte.ts:119` `serverId ? apiFor(serverId) : primaryApi()` — **(A)** `hostByWorkId`.
- `/Users/sidhu/solus/src/renderer/contexts/automations/automations.store.svelte.ts:116` `serverId ? apiFor(serverId) : primaryApi()` — **(A)** `hostByAutomationId`.
- `/Users/sidhu/solus/src/renderer/contexts/saved-prompts/saved-prompts.store.svelte.ts:33,:53,:58` `primaryApi().savedPromptsList/Create/Delete` — **(A)** keyed by `projectRoot`; owner derivable via `tasksStore.hostForProject(projectRoot)` / the run's `serverId`. No per-host map exists yet.

### `/Users/sidhu/solus/src/renderer/contexts/workspace/`
- `workspace.context.svelte.ts:243` `apiFor: (tabId) => tabId ? this.apiFor(tabId) : serverConnections.primaryApi(),` — **(A)**
- `:613` `: serverConnections.connectionFor()?.serverId` (`apiForRun`) — **(A)** `run.serverId`
- `:614` `if (!resolvedId) return serverConnections.primaryApi()` — **(A)** / arguably **(D)**: unreachable once every run carries a `serverId` (`session.factories.ts:18`).
- `:638` `: serverConnections.primaryApi()` (`apiForContext`, no `ctx.session.sessionId`) — **(B)** "deliberately session-less operation".
- `:1101` `return serverConnections.connectionFor()?.serverId ?? LOCAL_SERVER_ID` (`fallbackServerId`) — **(B)** the host new sessions land on.
- `:1335` `: serverConnections.primaryApi()` (`createAutomationDraftSession`) — **(A)** every caller passes `serverId` (`AutomationLaunchpad.svelte:100-104`).
- `:2318` `&& !serverConnections.connectionFor()` (web "connect a host" gate) — **(B)**
- `:2329` `&& session.run.serverId !== LOCAL_SERVER_ID` (remote path guard) — **(A)**
- `:2380` `is_remote_host: session.run.serverId !== LOCAL_SERVER_ID` (analytics) — **(A)**
- `:2507` `local: serverConnections.apiFor(LOCAL_SERVER_ID),` (`prepareHostCheckout` credential arm) — **(C)**
- `:2742` `const api = sess ? this.apiFor(this.activeTabId) : serverConnections.primaryApi()` — **(A)**
- `:2978`, `:2988` `void this.automationsStore.loadAll(serverConnections.connectionFor()?.serverId)` — **(B)** `loadAll(undefined)` already fans across `connectedServerIds()` (`automations.store:42-43`), so passing primary *narrows* it.
- `:3008` `loadAll(serverId ?? serverConnections.connectionFor()?.serverId)` — **(B)** same.
- `workspace-lifecycle.store.svelte.ts:194` `await serverConnections.primaryApi().start()` — **(B)** boot payload.
- `:226` `const result = await serverConnections.primaryApi().start()` (`refreshAgentAvailability`) — **(B)**
- `:239` `(this.deps.apiFor?.(targetTabId) ?? serverConnections.primaryApi()).getPluginCommands(…)` — **(A)**
- `:359` `… .diffStats(…)` — **(A)** `tabId`
- `:378` `… .listTurnSnapshots(…)` — **(A)** `tabId`
- `session-config.svelte.ts:86` `return this.deps.apiFor?.(tabId) ?? serverConnections.primaryApi()` — **(A)**
- `session-sidebar.store.svelte.ts:1104` `: serverConnections.primaryApi()` (`unpinSession`) — **(A)** `pin.serverId`
- `session-bootstrap.ts:296,:297` `?? LOCAL_SERVER_ID` / `snapTab.serverId ?? LOCAL_SERVER_ID` — **(A)**
- `session-bootstrap.ts:382` `?? serverConnections.connectionFor()?.serverId` — **(B)** tail after `ctx.sessionFor(tabId)?.run.serverId ?? snapTab.serverId`.
- `tab-snapshot.ts:20` `serverId: restoredSession?.run.serverId ?? LOCAL_SERVER_ID,` — **(A)**; `:34` `taskServerId: … ?? LOCAL_SERVER_ID,` — **(A)**
- `session.factories.ts:18` `serverId: LOCAL_SERVER_ID,` / `:20` `taskServerId: LOCAL_SERVER_ID,` — **(A)** the default run's host.
- `prompt-composer.ts:100` `if (serverId === LOCAL_SERVER_ID) return attachment.path` — **(A)**

---

## 7. Renderer components

- `/Users/sidhu/solus/src/renderer/lib/preview.svelte.ts:145` `? serverConnections.resolveId(serverId)` — **(A)**; `:146` `: serverConnections.connectionFor()?.serverId` — **(B)**; `:150` `: serverConnections.primaryApi()` — **(B)** (only when `hostFor()` is called with no `serverId`).
- `/Users/sidhu/solus/src/renderer/lib/voice-recorder.svelte.ts:106` `primaryApi().warmTranscription?.()` — **(C)**; `:278` `primaryApi().transcribeAudio(pending.samples)` — **(C)**; `:362` `primaryApi().logVoiceTranscription(row)` — **(C)**; `:456` `!!serverConnections.primaryApi().transcribeAudio` — **(C)**. Microphone is the client's; on desktop this must be the registered local target.
- `/Users/sidhu/solus/src/renderer/boot-scene.ts:271` `setActiveServerId(LOCAL_SERVER_ID)` (`useLocalHost` escape hatch, used at `:377`, `:406`) — **(C)**
- `/Users/sidhu/solus/src/renderer/components/review-mode/ReviewModeHost.svelte:60` `serverConnections.serverIdForApi(serverConnections.primaryApi()),` — **(A)** `session.prsStore.reviewModeServerId`.
- `/Users/sidhu/solus/src/renderer/components/pr-review/PrDiffPane.svelte:32` `serverConnections.serverIdForApi(serverConnections.primaryApi()),` — **(A)** `session.router.params("prReview")?.serverId`.
- `/Users/sidhu/solus/src/renderer/components/pr-review/PrReviewRoutePane.svelte:28` `: serverConnections.primaryApi(),` — **(A)** `params.serverId`.
- `/Users/sidhu/solus/src/renderer/components/prs/PrsPage.svelte:141` `prsSourceTabId ? session.apiFor(prsSourceTabId) : serverConnections.primaryApi(),` — **(A)** `prsSourceTabId` (derived from `session.runFor(tabId)`); the null arm is the project-with-no-open-tab case.
- `/Users/sidhu/solus/src/renderer/components/tasks/TasksPage.svelte:112` `serverConnections.connectionFor()?.serverId ??` — **(A)** `store.hostForProject(cwd)`.
- `/Users/sidhu/solus/src/renderer/components/tasks/task-page/TaskPage.svelte:77` `serverId: () => store.hostFor(taskId) ?? LOCAL_SERVER_ID,` — **(A)**; `:338` `serverId ? serverConnections.resolveId(serverId) : undefined,` — **(A)**; `:369` `: serverConnections.primaryApi();` (`stopSession`) — **(A)** `store.hostFor(taskId)`.
- `/Users/sidhu/solus/src/renderer/components/session/SessionSidebar.svelte:218` `const clientApi = serverConnections.primaryApi();` → `:220` `clientServerId: serverConnections.serverIdForApi(clientApi),` — **(C)** "which host is this client's own" for `prNavigationTarget`.
- `/Users/sidhu/solus/src/renderer/components/session/SessionPicker.svelte:116` `serverConnections.resolveId(LOCAL_SERVER_ID),` — **(C)** relies on the web alias (comment says so explicitly).
- `/Users/sidhu/solus/src/renderer/components/session/SessionPicker.svelte:438` `if (serverId !== serverConnections.connectionFor()?.serverId) {` — **(B)** "the picker scope uses paths from the primary host".
- `/Users/sidhu/solus/src/renderer/components/session/lib/remote-history-sources.ts:95` `const localServerId = serverConnections.resolveId(LOCAL_SERVER_ID)` — **(C)** relies on the web alias; `:101` filters it out of `remoteServerIds()`.
- `/Users/sidhu/solus/src/renderer/components/settings/SettingsTabKeybindings.svelte:175` `serverConnections.primaryApi().getAppGlobalShortcuts()` — **(C)** (guarded `if (windowCtx.isWeb) return`); `:188` `setAppGlobalShortcuts(…)` — **(C)**; `:222` `primaryApi().restartApp()` — **(C)**.
- `/Users/sidhu/solus/src/renderer/components/settings/SettingsPage.svelte:187` `serverConnections.connectionFor()?.serverId ?? "",` — **(B)** initial selection for a host-scoped settings page that otherwise iterates `connectedServerIds()` (`:191`); `:213` same in the reset effect — **(B)**.
- `/Users/sidhu/solus/src/renderer/components/settings/SettingsTabSkills.svelte:136` `: serverConnections.connectionFor()?.serverId;` — **(A)** `workspace.runFor(activeTabId)?.serverId`.
- `/Users/sidhu/solus/src/renderer/components/work/WorkHeaderActions.svelte:104` `await serverConnections.primaryApi().saveFileDialog(…)` — **(C)** comment already says "the user's client-side file picker, not the work's owner host".
- `/Users/sidhu/solus/src/renderer/components/document-shell/DocumentShell.svelte:529,:535` `primaryApi().googleUploadDoc(request)` — **(B)** marked `// primary-host by decision`; Google OAuth token is client-global.
- `/Users/sidhu/solus/src/renderer/components/pickers/DirectoryPicker.svelte:89` `const host = $derived(api ?? serverConnections.primaryApi());` — **(A)** `api`/`serverId` props (always supplied by both App.svelte call sites); `:90` `const isPrimaryHost = $derived(host === serverConnections.primaryApi());` — **(B)** — the "stay here" special case for the Places list (`:186`, `:230` pick `projectsStore.recentProjects` vs `remoteRecents`).
- `/Users/sidhu/solus/src/renderer/components/project-panel/ProjectPanel.svelte:118` `: (serverConnections.connectionFor()?.serverId ?? null),` — **(A)** `panelRun.serverId`.
- `/Users/sidhu/solus/src/renderer/components/automations/AutomationLaunchpad.svelte:91` `draftingServerId = serverConnections.connectionFor()?.serverId ?? null;` — **(B)**; `:134` `const serverId = serverConnections.connectionFor()?.serverId;` (`seedTemplate`) — **(B)**. Both pick a create-target with no user choice.
- `/Users/sidhu/solus/src/renderer/components/automations/AutomationBuilder.svelte:127` `const primaryServerId = serverConnections.connectionFor()?.serverId;` — **(B)** default selection in a picker that already lists `connectedServerIds()` (`:141`).
- `/Users/sidhu/solus/src/renderer/components/automations/AutomationsPage.svelte:45` `serverConnections.resolveId(serversStore.activeServerId),` — **(B)** page scoped to the "active" host rather than a chosen one.
- `/Users/sidhu/solus/src/renderer/components/input/InputToolbar.svelte:58` `sess?.run.serverId ?? run?.serverId ?? LOCAL_SERVER_ID` — **(A)**
- `/Users/sidhu/solus/src/renderer/components/input/InputBar.svelte:1204` `const serverId = run?.serverId ?? LOCAL_SERVER_ID;` — **(A)**
- `/Users/sidhu/solus/src/renderer/components/conversation/ConversationView.svelte:141`, `:146`, `:960` `sess?.run.serverId !== LOCAL_SERVER_ID` — **(A)** ×3.
- `/Users/sidhu/solus/src/renderer/components/conversation/agent-conversation/lib/agent-conversation.ts:300` `if (!serverId || serverId === LOCAL_SERVER_ID) return null` — **(A)**
- `/Users/sidhu/solus/src/renderer/components/servers/host-onboarding.store.svelte.ts:129` `sshApi = this.resolveApi(LOCAL_SERVER_ID)` — **(C)** SSH bootstrap shells out from "wherever local resolves"; falls back to code pairing on throw.
- `/Users/sidhu/solus/src/renderer/hooks/agentEvents.svelte.ts:14` `serverConnections.resolveId(sessionServerId) === serverId` — **(A)** (alias-independent, listed for completeness).

---

## 8. Run-on picker: the local/current-host special case

### `/Users/sidhu/solus/src/renderer/components/servers/run-on.ts`
- `:156` `(!!input.selectedHostId && input.selectedHostId !== LOCAL_SERVER_ID)` (`shouldShowRunOnPicker`) — **(A)** `selectedHostId` comes from `run.pendingHostDispatch?.serverId ?? run.serverId`.
- `:283` `if (serverConnections.resolveId(LOCAL_SERVER_ID) !== serverId) {` (`prepareHostCheckout` — skip credential delegation when target *is* local) — **(C)** relies on the web alias; comment `:280-281` documents it.
- (`:85` `if (!isLocalHost) serverConnections.ensure(serverId)` in `moveTabToHost` — **(A)**, `isLocalHost` is a caller-supplied param computed as `serverId === LOCAL_SERVER_ID` at `App.svelte:2118` / `client/src/App.svelte:670`.)

### `/Users/sidhu/solus/src/renderer/components/servers/RunOnPicker.svelte`
- `:174` `const currentHostId = $derived(run.serverId ?? LOCAL_SERVER_ID);` — **(A)**
- `:125-130` `localHost = servers.find((server) => server.local)` + `stayLabel = windowCtx.isWeb ? (localHost?.label ?? "This host") : "Local"` — **(B)** the "stay here" label depends on the synthesized web local row.
- `:133-135` `otherHosts = servers.filter((server) => !server.local)` — **(B)** same dependency ("On web the active server is folded into the local row").
- `:241-243` `hostLabel()` — `return !server || server.local ? stayLabel : server.label` — **(B)**
- `:285-293` `runLocally(local: ServerItem)` — **(A)** takes the row explicitly, but the row itself is the synthesized one.
- `:298-304` **the "stay here" no-op**: `if (server.id === selectedHostId) { open = false; return; }` — **(D)** dead once every row is a real host id (a same-host select is already a no-op through `moveTabToHost`'s `movingHosts` check at `run-on.ts:67`).
- `:308-312` `if (server.local) { event.preventDefault(); runLocally(server); return; }` — **(A)**/**(B)**: the branch itself is host-derivable, but `server.local` is true for the synthesized web row.
- `:330-342` `chooseLocalStart()` — `const local = serversStore.servers.find((server) => server.local); if (!local) return;` — **(B)** silently no-ops when there is no local row.
- `:346-353` `chooseNewWorktree()` → falls through to `chooseLocalStart(true)` — **(B)**
- `:576-604` markup: `{#if variant === "header" && isGitRepo}` … `<span>{stayLabel}</span>` "Start in" row — **(B)**
- `:657` `{#each serversStore.servers as server (server.id)}` (non-git variant lists the local row first) — **(B)**

### `/Users/sidhu/solus/src/renderer/components/servers/lib/run-target.ts`
- `:33` `stayLabel` and `:36` `hostIsLocal` inputs; `:65` `const onOwnRemoteHost = !dispatched && !hostIsLocal`; `:91-95` `label: kind === 'remote' ? hostLabel : worktree && !isolated ? 'New worktree' : stayLabel` — **(B)** the whole `local` kind is "the host that isn't named".

### Other `run-on.ts` consumers (no primary/local fallback — listed for coverage)
`/Users/sidhu/solus/src/renderer/components/layout/StatusBarControls.svelte:20` (`isRunOnHostLocked`), `/Users/sidhu/solus/src/renderer/components/input/InputBarHeader.svelte:24` and `/Users/sidhu/solus/src/renderer/components/input/ProjectChip.svelte:6` (`projectHostId` — reads `run.taskServerId ?? run.serverId`), `/Users/sidhu/solus/src/renderer/components/session/lib/remote-history-sources.ts:6` (`repoKeyForPath`), `/Users/sidhu/solus/src/renderer/contexts/workspace/workspace.context.svelte.ts:78` (`moveTabToHost`, `prepareHostCheckout`), `client/src/App.svelte:40`, `src/renderer/App.svelte:34`.

---

## 9. Tests (all **(D)** for production purposes, but they pin the deleted behaviour)

- `/Users/sidhu/solus/tests/unit/prs-store-effort.test.ts:11` `const api = () => serverConnectionsMock.primaryApi()`
- `/Users/sidhu/solus/tests/unit/run-on.test.ts:26` `selectedHostId: LOCAL_SERVER_ID,`
- `/Users/sidhu/solus/tests/unit/run-on-preparation.test.ts:39,:72,:94` `serverConnections.resolveId(LOCAL_SERVER_ID)` — `:36-38` comment asserts the web alias explicitly.
- `/Users/sidhu/solus/tests/unit/host-foundations.test.ts:43-45` `expect(hostPolicy.isClientMachine('web-primary')).toBe(true)` — asserts the alias.
- `/Users/sidhu/solus/tests/unit/server-connections.test.ts:118,:178` `connections.connectionFor('server')` — arg form, unaffected.

---

## Totals

| Class | Count |
|---|---|
| **(A)** session/tab/ctx-scoped — a specific host is derivable in scope | **73** |
| **(B)** genuinely client-global read (settings/boot/analytics) | **81** |
| **(C)** local-platform-capability (desktop-only local server access) | **53** |
| **(D)** dead/vestigial | **11** |
| **Total** | **218** |

Breakdown of the requested buckets:
- `primaryApi(` / `eventsForPrimary(` — **75 production call sites** (+2 definitions, +1 test mock) across 34 files.
- `connectionFor()` with **no argument** — **31 call sites** across 22 files (vs. 14 sites that pass a `serverId`).
- `resolveId(LOCAL_SERVER_ID)` — **4 production sites** (`host-policy.ts:10`, `SessionPicker.svelte:116`, `remote-history-sources.ts:95`, `run-on.ts:283`) + 3 in tests. Every one is **(C)** and depends on the web alias; `host-policy.ts:10` transitively carries 10 more consumers.
- Other `LOCAL_SERVER_ID` uses in `src/renderer` + `client/src` + `src/client-core` — **56 sites**; of those, only the four above plus `servers.store.svelte.ts:182` (`resolveHostId`) and `server-connections.ts:191/441` implement or consume the local→primary mapping. The rest are plain default-host / is-this-my-machine comparisons.
- `switchTo(` — **1 definition + 6 call sites** (`App.svelte:1541`, `ServerSetupSurface.svelte:73`, `MobileServerSheet.svelte:37`, `HostOnboarding.svelte:81`, `AddServerModal.svelte:100`, `servers.store.svelte.ts:418` via `useLocalHost`, whose 3 UI callers are listed).
- Synthesized web local row — **13 sites in `servers.store.svelte.ts`** (`:124-143`, `:167`, `:172`, `:180-184`, `:333`, `:427`, `:456`, `:475`, `:519-521`, `:529`), consumed by the Run-on picker (`server.local` / `stayLabel` / `otherHosts`) and `hostFor`/`affinityFor` across ~10 components.
