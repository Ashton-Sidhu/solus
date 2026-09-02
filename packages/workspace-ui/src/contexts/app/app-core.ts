import { onDestroy } from 'svelte'
import { SettingsContext, setSettingsContext } from './settings.context.svelte'
import { WorkspaceContext, setWorkspaceContext } from '../workspace/workspace.context.svelte'
import { WindowContext, setWindowContext } from './window.context.svelte'
import { StatusBarContext, setStatusBarContext } from './status-bar.context.svelte'
import { PlanStore, setPlanStore } from '../plans/plan.store.svelte'
import { SessionEnvironmentStore, setSessionEnvironmentStore } from '../git/session-environment.store.svelte'
import { ProjectConfigStore, setProjectConfigStore } from '../projects/project-config.store.svelte'
import {
  TextGenerationSettingsStore,
  setTextGenerationSettingsStore,
} from '../projects/text-generation-settings.store.svelte'
import { OtelSettingsStore, setOtelSettingsStore } from '../projects/otel-settings.store.svelte'
import { AgentContext, setAgentContext } from './agent.context.svelte'
import { SessionSidebarStore, setSessionSidebarStore } from '../workspace/session-sidebar.store.svelte'
import { VoiceModelStore, setVoiceModelStore } from './voice-model.store.svelte'
import {
  PullRequestsContext,
  setPullRequestsContext,
} from '../prs/pull-requests.context.svelte'
import { KeybindingsContext, setKeybindingsContext } from '../../lib/keybindings/dispatcher.svelte'
import {
  reviewGuideStore,
  sessionGuideIdentity,
} from '../../components/review/review-guide.store.svelte'
import { toasts } from '../../lib/toasts'

export interface AppCore {
  settings: SettingsContext
  windowCtx: WindowContext
  statusBar: StatusBarContext
  planStore: PlanStore
  sessionEnvironmentStore: SessionEnvironmentStore
  projectConfigStore: ProjectConfigStore
  textGenerationSettingsStore: TextGenerationSettingsStore
  sessionSidebarStore: SessionSidebarStore
  voiceModelStore: VoiceModelStore
  pullRequests: PullRequestsContext
  session: WorkspaceContext
  agent: AgentContext
  keybindings: KeybindingsContext
}

/**
 * Constructs every shared context/store, registers them on the Svelte context,
 * and wires the cross-store bindings. The single source of truth shared by the
 * Electron renderer (`src/renderer/App.svelte`) and the web client
 * (`client/src/App.svelte`) so a new store added here lands in both shells.
 *
 * Platform-specific setup (analytics, root scaling, design mode, click-through,
 * view modes) stays in each App.svelte — only what's identical lives here.
 */
export function createAppCore(): AppCore {
  const settings = new SettingsContext()
  const windowCtx = new WindowContext()
  const statusBar = new StatusBarContext(settings)
  const planStore = new PlanStore()
  const sessionEnvironmentStore = new SessionEnvironmentStore()
  const projectConfigStore = new ProjectConfigStore()
  const textGenerationSettingsStore = new TextGenerationSettingsStore()
  const otelSettingsStore = new OtelSettingsStore()
  const agent = new AgentContext(settings)
  const pullRequests = new PullRequestsContext()
  const session = new WorkspaceContext(
    settings,
    windowCtx,
    statusBar,
    planStore,
    sessionEnvironmentStore,
    pullRequests,
    agent,
  )
  const sessionSidebarStore = new SessionSidebarStore(settings, session, planStore, pullRequests.projects)
  session.onTabClosing = (tabId) => sessionSidebarStore.clearTabAttention(tabId)
  const voiceModelStore = new VoiceModelStore()
  statusBar.bind(session)
  statusBar.bindAgent(agent)

  const unsubscribeReviewGuideReady = reviewGuideStore.onReady((serverId, event) => {
    if (event.scope !== 'session') return
    const tabId = session.tabOrder.find((candidateTabId) => {
      if (session.serverIdFor(candidateTabId) !== serverId) return false
      const identity = sessionGuideIdentity(session.sessionFor(candidateTabId))
      return identity?.repoRoot === event.repoRoot && identity.key === event.key
    })
    if (!tabId) return

    const title = session.sessionFor(tabId)?.title?.trim()
    toasts.success(title ? `Review guide ready for “${title}”` : 'Review guide ready', {
      duration: 10_000,
      action: {
        label: 'Open guide',
        onAction: () => {
          if (!session.tabs[tabId]) return
          if (session.activeTabId !== tabId) session.selectTab(tabId)
          session.isExpanded = true
          session.enterReview('session', tabId)
        },
      },
    })
  })
  onDestroy(unsubscribeReviewGuideReady)

  const keybindings = new KeybindingsContext()
  keybindings.setOverrides(settings.keybindings)

  setSettingsContext(settings)
  setWindowContext(windowCtx)
  setStatusBarContext(statusBar)
  setWorkspaceContext(session)
  setPlanStore(planStore)
  setSessionEnvironmentStore(sessionEnvironmentStore)
  setProjectConfigStore(projectConfigStore)
  setTextGenerationSettingsStore(textGenerationSettingsStore)
  setOtelSettingsStore(otelSettingsStore)
  setSessionSidebarStore(sessionSidebarStore)
  setVoiceModelStore(voiceModelStore)
  setPullRequestsContext(pullRequests)
  setAgentContext(agent)
  setKeybindingsContext(keybindings)

  return {
    settings,
    windowCtx,
    statusBar,
    planStore,
    sessionEnvironmentStore,
    projectConfigStore,
    textGenerationSettingsStore,
    sessionSidebarStore,
    voiceModelStore,
    pullRequests,
    session,
    agent,
    keybindings,
  }
}
