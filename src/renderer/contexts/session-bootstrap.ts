import type { AgentId } from '../../shared/types'
import { makeInputState, makeSession, makeTab } from './session.factories'
import { loadSessionTranscript } from './session-transcript'
import { hasConversation } from './session.utils'
import { initDraftState, loadDrafts, loadPersistedTabs, type PersistedTab, type TabDrafts } from './tab-persistence'
import type { WorkspaceContext } from './workspace.context.svelte'

/**
 * How many recent messages to hydrate per tab on startup. Older messages stay on
 * disk and are pulled in on demand when the user scrolls to the top. Matches the
 * conversation's initial render cap so the windowed load fills the first screen.
 */
const HISTORY_WINDOW = 100

export async function bootstrapRuntimeTabs(ctx: WorkspaceContext): Promise<void> {
  const snapshot = loadPersistedTabs()
  const drafts = loadDrafts()
  // Seed the live draft map so unvisited tabs retain their saved drafts even
  // though the new per-keystroke effect only patches the active tab.
  initDraftState(drafts)
  if (!snapshot?.tabs?.length) {
    if (drafts) ctx.activeInput.text = drafts.activeInputText
    ctx.hydrating = false
    return
  }

  try {
    await _hydrateTabs(ctx, snapshot.tabs, snapshot.tabOrder, snapshot.activeTabId, drafts)
  } finally {
    ctx.hydrating = false
  }
}

/**
 * Re-register tabs with the server and re-bind any alive sessions without
 * clearing client state. Used by the network-gap recovery path.
 */
export async function resyncRuntime(ctx: WorkspaceContext): Promise<void> {
  // Clear in-flight streaming state so replayed text doesn't double-append.
  ctx.streaming.text = {}
  ctx.turnSnapshots = {}

  const tabIds = [...ctx.tabOrder]
  await Promise.all(tabIds.map(async (tabId) => {
    const tab = ctx.tabs[tabId]
    const session = tab ? ctx.sessions[tab.sessionId] : undefined
    if (!tab || !session) return

    // Re-register with the server so event routing is alive again.
    await window.solus.createTab(tabId).catch(() => null)

    if (session.agentSessionId) {
      const info = await window.solus.bindRuntimeSession(ctx.ctxFor(tabId)).catch(() => null)
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
}

async function _hydrateTabs(
  ctx: WorkspaceContext,
  persistedTabs: PersistedTab[],
  tabOrder: string[],
  activeTabId: string,
  drafts: TabDrafts | null,
): Promise<void> {
  for (const snapTab of persistedTabs) {
    let tab = ctx.tabs[snapTab.tabId]
    let session = tab ? ctx.sessions[tab.sessionId] : undefined
    const draftText = drafts?.tabs[snapTab.tabId] ?? ''

    if (!tab || !session) {
      session = makeSession(ctx.settings, {
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

  // Re-register all tabs with the server in parallel.
  await Promise.all(Object.keys(ctx.tabs).map((tabId) =>
    window.solus.createTab(tabId).catch(() => null),
  ))

  if (!ctx.tabs[ctx.activeTabId]) {
    ctx.activeTabId = ctx.tabOrder.find((id) => ctx.tabs[id]) ?? ''
  }
  ctx.pruneTabOrder()

  // Hydrate the tab the user is actually looking at first, then release the
  // hydrating gate so the UI is interactive — the remaining tabs (all hidden via
  // display:none) finish loading their transcripts in the background.
  const activeSnap = persistedTabs.find((t) => t.tabId === ctx.activeTabId)
  if (activeSnap) await hydrateTab(ctx, activeSnap).catch(() => {})

  const rest = persistedTabs.filter((t) => t.tabId !== ctx.activeTabId)
  void Promise.all(rest.map((snapTab) => hydrateTab(ctx, snapTab).catch(() => {})))
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

    const info = await window.solus.bindRuntimeSession(ctx.ctxFor(snapTab.tabId)).catch(() => null)
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

  void ctx.refreshPluginCommands(session.workingDirectory, snapTab.tabId)
}
