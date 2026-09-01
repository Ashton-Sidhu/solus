import { arg, optionalArg, textArg } from './args'
import type {
  AgentTaskLifecyclePolicy,
  HostCapabilities,
  RuntimeSessionInfo,
  ServerCapabilities,
  VoiceModelStatus,
} from '@solus/contracts/types'
import type { DemoBackend } from '../server'
import type { DemoStore } from '../store'

export function registerBootHandlers(backend: DemoBackend, store: DemoStore): void {
  let sessionCounter = 0
  let agentTaskLifecyclePolicy: AgentTaskLifecyclePolicy = 'moderate'
  backend.register('start', () => store.startInfo())
  backend.register('serverGetCapabilities', (): HostCapabilities => ({
    attachUpload: true,
    assetUrls: true,
    skillsInstall: true,
    skillsSearch: true,
    voiceModel: true,
    automations: true,
    editors: [],
    githubProvider: true,
  }))
  backend.register('getPluginCommands', () => ({ global: [], project: [] }))
  backend.register('getServerCapabilities', (): ServerCapabilities => ({
    headless: true,
    desktopHandlers: false,
    agents: { claude: true, codex: true },
    dictation: false,
    platform: 'web',
    version: 'demo',
    projectCount: 1,
    agentAuth: { claude: true },
    gitAuth: { github: false },
    serverName: 'Solus Demo',
    agentTaskLifecyclePolicy,
  }))
  backend.register('setAgentTaskLifecyclePolicy', (args) => {
    const [policy] = args
    if (policy === 'none' || policy === 'moderate' || policy === 'autonomous') {
      agentTaskLifecyclePolicy = policy
    }
    return { agentTaskLifecyclePolicy }
  })
  backend.register('voiceModelStatus', (): VoiceModelStatus => ({
    state: 'error',
    error: 'Voice input is unavailable in demo mode.',
  }))
  backend.register('connectionsGetServerInfo', () => ({
    host: 'demo',
    port: 0,
    allowLan: false,
    installationId: 'demo',
    remoteAccess: false,
    requireAuth: false,
  }))
  backend.register('watchSession', (args) => {
    const input = arg<{ sessionId?: string }>(args, 0)
    return { sessionId: input?.sessionId ?? `demo-runtime-session-${++sessionCounter}` }
  })
  backend.register('unwatchSession', () => undefined)
  backend.register('bindRuntimeSession', (args): RuntimeSessionInfo | null => {
    const ctx = optionalArg<{ session?: { agentSessionId?: string | null; preferredModel?: string | null } }>(args, 0)
    if (!ctx?.session?.agentSessionId) return null
    const agent = store.startInfo().agents[0]
    return {
      modelConfig: {
        modelId: ctx.session.preferredModel ?? agent?.defaultModel ?? null,
        reasoningEffort: 'high',
        contextWindow: 1_000_000,
        fastMode: false,
      },
      permissionMode: 'auto',
      status: 'idle',
      rateLimitInfo: null,
      queuedPrompts: [],
    }
  })
  backend.register('listRecentProjects', () => [])
  backend.register('listProjects', () => [])
  backend.register('worktreeBranches', () => [])
  backend.register('listAttention', () => [])
  // The marketing replay is presentation, not a background client. Its iframe
  // must never turn scripted permission or task events into audible alerts.
  backend.register('isVisible', () => true)
  backend.register('searchFiles', () => ({ files: [] }))
  backend.register('listDirectory', (args) => ({
    entries: [],
    parentPath: null,
    currentPath: textArg(args, 0) ?? store.startInfo().workspacePath,
    error: null,
  }))
  backend.register('usageLimits', () => [])
  backend.register('outboxList', () => [])
  backend.register('readLedger', () => null)
  backend.register('projectConfigLoad', () => ({ version: 1 }))
  backend.register('detectEditors', () => ({ editors: [], terminals: [] }))
}
