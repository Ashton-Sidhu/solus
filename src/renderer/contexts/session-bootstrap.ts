import type { AgentId } from '../../shared/types'
import { loadServers, LOCAL_SERVER_ID } from '../../client-core/server-registry'
import { makeInputState, makeSession, makeTab } from './session.factories'
import { loadSessionTranscript } from './session-transcript'
import { hasConversation } from './session.utils'
import { initDraftState, loadDrafts, loadPersistedTabs, type PersistedTab, type PersistedTabs, type TabDrafts } from './tab-persistence'
import type { WorkspaceContext } from './workspace.context.svelte'

/**
 * How many recent messages to hydrate per tab on startup. Older messages stay on
 * disk and are pulled in on demand when the user scrolls to the top. Matches the
 * conversation's initial render cap so the windowed load fills the first screen.
 */
const HISTORY_WINDOW = 100

interface DeferredHydrationState {
  pending: Map<string, PersistedTab>
  running: Set<string>
  drainScheduled: boolean
}

const deferredHydrations = new WeakMap<WorkspaceContext, DeferredHydrationState>()

/** Snapshot captured by the synchronous materialize step, consumed by the async
 *  runtime-attach step. Presence also guards materialize against re-running. */
const materializations = new WeakMap<WorkspaceContext, { snapshot: PersistedTabs | null }>()
/** Guards the async attach step against a re-running boot effect. */
const attached = new WeakSet<WorkspaceContext>()

function scheduleIdle(callback: () => void): void {
  if ('requestIdleCallback' in window) {
    window.requestIdleCallback(callback, { timeout: 1_500 })
    return
  }
  window.setTimeout(callback, 250)
}

function scheduleDeferredDrain(ctx: WorkspaceContext, state: DeferredHydrationState): void {
  if (state.drainScheduled || state.pending.size === 0) return
  state.drainScheduled = true
  scheduleIdle(() => {
    state.drainScheduled = false
    const nextTabId = state.pending.keys().next().value as string | undefined
    if (nextTabId) void hydrateDeferredTab(ctx, state, nextTabId)
  })
}

async function hydrateDeferredTab(
  ctx: WorkspaceContext,
  state: DeferredHydrationState,
  tabId: string,
): Promise<void> {
  const snapTab = state.pending.get(tabId)
  if (!snapTab || state.running.has(tabId)) return
  state.pending.delete(tabId)
  state.running.add(tabId)
  try {
    await hydrateTab(ctx, snapTab)
  } catch {
    // A missing/deleted transcript should not stop the remaining startup queue.
  } finally {
    state.running.delete(tabId)
    scheduleDeferredDrain(ctx, state)
  }
}

/** Promote an inactive persisted tab out of the idle queue when the user selects it. */
export function prioritizeTabHydration(ctx: WorkspaceContext, tabId: string): void {
  const state = deferredHydrations.get(ctx)
  if (!state?.pending.has(tabId)) return
  void hydrateDeferredTab(ctx, state, tabId)
}

/**
 * Synchronous first step: read the persisted snapshot + drafts from localStorage
 * and materialize all tabs/sessions/order/active-tab into the workspace context so
 * the tab strip paints on the very first mounted frame — no server round trip gates
 * this. The async runtime-attach (createTab registrations, transcript load, bind)
 * runs later from bootstrapRuntimeTabs.
 *
 * Releases the `hydrating` gate: in-memory state now mirrors the saved snapshot, so
 * the persist effects can re-run without clobbering it. Per-session `loadingHistory`
 * (set during attach) covers the conversation skeleton, so the gate need not wait on
 * transcript/bind. Call once during App setup; re-entry is guarded.
 */
export function materializeTabs(ctx: WorkspaceContext): void {
  if (materializations.has(ctx)) return
  const snapshot = loadPersistedTabs()
  const drafts = loadDrafts()
  materializations.set(ctx, { snapshot })
  // Seed the live draft map so unvisited tabs retain their saved drafts even
  // though the new per-keystroke effect only patches the active tab.
  initDraftState(drafts)
  if (!snapshot?.tabs?.length) {
    if (drafts) ctx.activeInput.text = drafts.activeInputText
    ctx.hydrating = false
    return
  }
  _materializeTabs(ctx, snapshot.tabs, snapshot.tabOrder, snapshot.activeTabId, drafts)
  ctx.hydrating = false
}

/**
 * Async second step: register the materialized tabs with the server, hydrate the
 * active tab's transcript + bind its live session, and queue the rest for idle-time
 * hydration. Assumes materializeTabs already built the client-side tabs; falls back
 * to running it if the caller skipped it. Guarded so a re-running boot effect can't
 * double-register or double-hydrate.
 */
export async function bootstrapRuntimeTabs(ctx: WorkspaceContext): Promise<void> {
  if (!materializations.has(ctx)) materializeTabs(ctx)
  if (attached.has(ctx)) return
  attached.add(ctx)
  const snapshot = materializations.get(ctx)?.snapshot
  if (!snapshot?.tabs?.length) return
  try {
    await _attachRuntimeTabs(ctx, snapshot.tabs)
  } catch (error) {
    attached.delete(ctx)
    throw error
  }
}

/**
 * Re-register tabs with the server and re-bind any alive sessions without
 * clearing client state. Used by the network-gap recovery path.
 */
export async function resyncRuntime(ctx: WorkspaceContext, serverId?: string): Promise<void> {
  ctx.runtimeSyncing = true
  try {
    const tabIds = ctx.tabOrder.filter((tabId) => !serverId || ctx.sessionFor(tabId)?.serverId === serverId)
    // Clear only the affected host's in-flight state so replayed text doesn't
    // double-append without churning healthy tabs on other connections.
    for (const tabId of tabIds) {
      delete ctx.streaming.text[tabId]
      delete ctx.turnSnapshots[tabId]
    }
    await Promise.all(tabIds.map(async (tabId) => {
      const tab = ctx.tabs[tabId]
      const session = tab ? ctx.sessions[tab.sessionId] : undefined
      if (!tab || !session) return

      // Re-register with the server so event routing is alive again.
      const api = ctx.apiFor(tabId)
      await api.createTab(tabId).catch(() => null)

      if (session.agentSessionId) {
        const info = await api.bindRuntimeSession(ctx.ctxFor(tabId)).catch(() => null)
        if (info && session) {
          session.modelConfig.modelId = info.modelConfig.modelId
          session.modelConfig.reasoningEffort = info.modelConfig.reasoningEffort
          session.modelConfig.contextWindow = info.modelConfig.contextWindow
          session.modelConfig.fastMode = info.modelConfig.fastMode
          session.permissionMode = info.permissionMode
          session.status = info.status
          session.rateLimitInfo = info.rateLimitInfo
          ctx.reconcileQueuedPrompts(tabId, info.queuedPrompts)
        } else if (info === null) {
          // Session no longer alive.
          session.status = 'idle'
          session.rateLimitInfo = null
        }
      }
    }))
  } finally {
    ctx.runtimeSyncing = false
  }
}

/** Synchronous builder: create tabs/sessions from the snapshot and restore order +
 *  active tab. Pure client-state mutation, no RPC — safe to run before first paint. */
function _materializeTabs(
  ctx: WorkspaceContext,
  persistedTabs: PersistedTab[],
  tabOrder: string[],
  activeTabId: string,
  drafts: TabDrafts | null,
): void {
  const savedServers = loadServers()
  for (const snapTab of persistedTabs) {
    let tab = ctx.tabs[snapTab.tabId]
    let session = tab ? ctx.sessions[tab.sessionId] : undefined
    const draftText = drafts?.tabs[snapTab.tabId] ?? ''

    if (!tab || !session) {
      const serverId = snapTab.serverInstallationId
        ? savedServers.find((server) => server.installationId === snapTab.serverInstallationId)?.id
          ?? snapTab.serverId
          ?? LOCAL_SERVER_ID
        : snapTab.serverId ?? LOCAL_SERVER_ID
      session = makeSession(ctx.settings, {
        serverId,
        agentSessionId: snapTab.agentSessionId,
        provider: snapTab.provider,
        status: 'idle',
        workingDirectory: snapTab.workingDirectory || ctx.staticInfo?.workspacePath || '~',
        additionalDirs: [...snapTab.additionalDirs],
        gitContext: snapTab.gitContext,
        worktreeBaseBranch: snapTab.worktreeBaseBranch,
        modelConfig: snapTab.modelConfig ? { ...snapTab.modelConfig } : undefined,
        permissionMode: snapTab.permissionMode as any,
      })
      tab = makeTab(session.id, {
        id: snapTab.tabId,
        title: snapTab.title || 'New Tab',
        input: makeInputState({ text: draftText }),
      })
      tab.hasUnread = snapTab.hasUnread ?? false
      ctx.sessions[session.id] = session
      ctx.tabs[tab.id] = tab
    } else if (draftText) {
      tab.input.text = draftText
    }
  }

  // Restore order and active tab from snapshot.
  for (const tabId of tabOrder) {
    if (ctx.tabs[tabId] && !ctx.tabOrder.includes(tabId)) ctx.tabOrder.push(tabId)
  }
  // Any tabs that weren't in the persisted order get appended.
  for (const tabId of Object.keys(ctx.tabs)) {
    if (!ctx.tabOrder.includes(tabId)) ctx.tabOrder.push(tabId)
  }

  if (ctx.tabs[activeTabId]) ctx.activeTabId = activeTabId
}

/** Async runtime attach: register tabs with the server, hydrate the active tab, and
 *  queue the rest for idle-time hydration. */
async function _attachRuntimeTabs(
  ctx: WorkspaceContext,
  persistedTabs: PersistedTab[],
): Promise<void> {
  // Start registrations independently. A request queued on an offline host must
  // not prevent healthy hosts from hydrating their tabs.
  for (const tabId of Object.keys(ctx.tabs)) {
    void ctx.apiFor(tabId).createTab(tabId).catch(() => null)
  }

  if (!ctx.tabs[ctx.activeTabId]) {
    ctx.activeTabId = ctx.tabOrder.find((id) => ctx.tabs[id]) ?? ''
  }
  ctx.pruneTabOrder()

  // Hydrate the tab the user is actually looking at first (its loadingHistory
  // flag drives the conversation skeleton). Remaining tabs are intentionally
  // serialized through idle time; selecting one promotes it immediately.
  const activeSnap = persistedTabs.find((t) => t.tabId === ctx.activeTabId)
  if (activeSnap) void hydrateTab(ctx, activeSnap).catch(() => {})

  const rest = persistedTabs.filter((t) => t.tabId !== ctx.activeTabId)
  const deferredState: DeferredHydrationState = {
    pending: new Map(rest.map((snapTab) => [snapTab.tabId, snapTab])),
    running: new Set(),
    drainScheduled: false,
  }
  deferredHydrations.set(ctx, deferredState)
  scheduleDeferredDrain(ctx, deferredState)
}

/**
 * Hydrate a single tab: load its (windowed) transcript, then bind any live
 * runtime session. Loads the transcript before binding because bindRuntimeSession
 * may replay in-flight events immediately; if those land first, the conversation
 * guard would treat the tab as populated and skip the persisted transcript.
 */
async function hydrateTab(ctx: WorkspaceContext, snapTab: PersistedTab): Promise<void> {
  const tab = ctx.tabs[snapTab.tabId]
  const session = tab ? ctx.sessions[tab.sessionId] : undefined
  if (!tab || !session) return

  if (snapTab.agentSessionId) {
    if (!hasConversation(session)) {
      const sessionId = snapTab.agentSessionId
      const provider = (snapTab.provider ?? ctx.settings.activeAgent) as AgentId
      const displayCwd = snapTab.workingDirectory || ctx.staticInfo?.workspacePath || '~'
      // Claude persists transcripts under the dir it actually ran in. Worktree
      // sessions ran in the worktree, not the project root, so load from there
      // or the .jsonl folder won't resolve and the transcript comes back empty.
      // (Codex reads by session id and ignores the path entirely.)
      const loadPath = snapTab.gitContext?.worktreePath || displayCwd
      const tabId = snapTab.tabId
      session.loadingHistory = true
      try {
        const transcript = await loadSessionTranscript(ctx, {
          sessionId,
          loadPath,
          displayCwd,
          provider,
          ctx: ctx.ctxFor(tabId),
          limit: HISTORY_WINDOW,
          shouldApply: () => {
            const t = ctx.tabs[tabId]
            if (!t) return false
            const s = ctx.sessions[t.sessionId]
            return !!s && !hasConversation(s)
          },
        })
        const t = ctx.tabs[tabId]
        const s = t ? ctx.sessions[t.sessionId] : undefined
        if (s && transcript.messages.length > 0) {
          s.messages.splice(0, s.messages.length, ...transcript.messages)
          s.progress = transcript.progress
          s.historyTruncated = transcript.truncated
          ctx.recomputeChangedFiles(tabId)
          for (const planId of transcript.planIds) void ctx.planStore.hydrateAnnotations(planId)
        }
      } finally {
        const t = ctx.tabs[tabId]
        const s = t ? ctx.sessions[t.sessionId] : undefined
        if (s) s.loadingHistory = false
      }
    }

    const info = await ctx.apiFor(snapTab.tabId).bindRuntimeSession(ctx.ctxFor(snapTab.tabId)).catch(() => null)
    if (info && session) {
      session.modelConfig.modelId = info.modelConfig.modelId
      session.modelConfig.reasoningEffort = info.modelConfig.reasoningEffort
      session.modelConfig.contextWindow = info.modelConfig.contextWindow
      session.modelConfig.fastMode = info.modelConfig.fastMode
      session.permissionMode = info.permissionMode
      session.status = info.status
      session.rateLimitInfo = info.rateLimitInfo
      ctx.reconcileQueuedPrompts(snapTab.tabId, info.queuedPrompts)
    }
  }

  await ctx.env.refreshGitEnvironment({ tabId: snapTab.tabId })
  void ctx.refreshPluginCommands(session.workingDirectory, snapTab.tabId)
}
