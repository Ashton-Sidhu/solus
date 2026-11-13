import { HostPolicies } from '@solus/contracts/host-policies'
import { arg, optionalArg, textArg } from './args'
import { DEFAULT_HOST_CONFIG, hostConfigPatchSchema, mergeHostConfig, type HostConfigSnapshot, type TypeSafeKeyStatus } from '@solus/contracts/host-config'
import type {
  HostCapabilities,
  ProjectConfig,
  ProjectEntry,
  RuntimeSessionInfo,
  VoiceModelStatus,
  WatchSessionInput,
} from '@solus/contracts/types'
import type { HostOrganizationsStatus } from '@solus/contracts/organization-scope'
import type { ConnectionsServerInfo } from '@solus/contracts/host-api'
import type { HostWebhookSettings, Webhook } from '@solus/contracts/webhooks'
import type { AppSummary } from '@solus/contracts/apps'
import type { DemoBackend } from '../server'
import { DEMO_USER, type DemoStore } from '../store'

/** The folders the demo's sessions run in. Each one is a project the page filters offer. */
const DEMO_PROJECT_FOLDERS = ['api-gateway', 'web-dashboard', 'billing-service', 'marketing-site', 'infra', 'ios-app']
const DEMO_PROJECTS_ADDED_AT = '2026-01-12T09:00:00.000Z'

export function registerBootHandlers(backend: DemoBackend, store: DemoStore): void {
  let config = structuredClone(DEFAULT_HOST_CONFIG)
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
    headless: true,
    desktopHandlers: false,
    agents: { claude: true, codex: true },
    dictation: false,
    platform: 'web',
    version: 'demo',
    projectCount: 1,
    agentAuth: { claude: true },
    gitAuth: { github: false },
  }))
  backend.register('getPluginCommands', () => ({ global: [], project: [] }))
  backend.register('configGet', (): HostConfigSnapshot => ({ config }))
  backend.register('typeSafeKeyStatus', (): TypeSafeKeyStatus => ({ location: 'host', source: null }))
  backend.register('configUpdate', (args): HostConfigSnapshot => {
    config = mergeHostConfig(config, hostConfigPatchSchema.parse(args[0]))
    return { config }
  })
  backend.register('voiceModelStatus', (): VoiceModelStatus => ({
    state: 'error',
    error: 'Voice input is unavailable in demo mode.',
  }))
  backend.register('connectionsGetServerInfo', (): ConnectionsServerInfo => ({
    host: 'demo',
    port: 0,
    allowLan: false,
    installationId: 'demo',
    remoteAccess: false,
    requireAuth: false,
    trustLocalNetwork: false,
    routes: [],
    hostKind: 'personal',
    roles: ['execution'],
    principal: 'local-owner',
    permissions: ['host'],
    user: DEMO_USER,
  }))
  const runtimeInfo = (preferredModel?: string | null): RuntimeSessionInfo => ({
    modelConfig: {
      modelId: preferredModel ?? store.startInfo().agents[0]?.defaultModel ?? null,
      reasoningEffort: 'high',
      contextWindow: 1_000_000,
      fastMode: false,
    },
    permissionMode: 'full-access',
    status: 'idle',
    rateLimitInfo: null,
    queuedPrompts: [],
  })
  backend.register('watchSession', (args) => {
    const input = arg<WatchSessionInput>(args, 0)
    return input.attachRuntime ? { runtime: runtimeInfo() } : {}
  })
  backend.register('unwatchSession', () => undefined)
  backend.register('bindRuntimeSession', (args): RuntimeSessionInfo | null => {
    const ctx = optionalArg<{ session?: { agentSessionId?: string | null; preferredModel?: string | null } }>(args, 0)
    if (!ctx?.session?.agentSessionId) return null
    return runtimeInfo(ctx.session.preferredModel)
  })
  backend.register('listRecentProjects', () => [])
  backend.register('listProjects', (): ProjectEntry[] => DEMO_PROJECT_FOLDERS.map((folderName, index) => ({
    key: folderName,
    path: `/home/demo/${folderName}`,
    folderName,
    addedAt: DEMO_PROJECTS_ADDED_AT,
    // The list orders by last use: the demo's own project leads.
    lastUsedAt: new Date(Date.parse(DEMO_PROJECTS_ADDED_AT) - index * 60_000).toISOString(),
    repositoryKey: `github.com/acme/${folderName}`,
  })))
  backend.register('worktreeBranches', () => [])
  backend.register('listAttention', () => [])
  // The marketing replay is presentation, not a background client. Its iframe
  // must never turn scripted permission or task events into audible alerts.
  backend.register('isVisible', () => true)
  backend.register('searchFiles', () => ({ files: [] }))
  backend.register('listDirectory', (args) => ({
    entries: [],
    parentPath: null,
    currentPath: textArg(args, 0) ?? store.startInfo().projectPath,
    error: null,
  }))
  backend.register('usageLimits', () => [])
  // Webhooks (docs/plans/webhooks.md): the demo host has none and no URL.
  backend.register('webhookList', (): Webhook[] => [])
  backend.register('hostWebhookSettingsRead', (): HostWebhookSettings => ({ publicUrl: null, holdWhileOffline: null, linked: false }))
  // Apps (docs/plans/apps.md): the demo host has none.
  backend.register('appList', (): AppSummary[] => [])
  // Organization scope (organization-scope.md): the demo host is registered to no
  // account, so it stands in no organization, publishes nothing, and has no
  // organization Insights to answer.
  const hostOrganizations = (): HostOrganizationsStatus => ({
    registered: false,
    hostId: null,
    category: 'personal',
    owner: null,
    organizations: [],
    insightsOptIn: [],
    attachedAt: null,
    apiUrl: null,
    delivery: [],
    deliveryError: null,
  })
  backend.register('hostOrganizations', hostOrganizations)
  // The demo host has no MDM policy and no organization policy.
  backend.register('hostPolicy', () => HostPolicies.none.set)
  backend.register('hostSetInsightsOptIn', hostOrganizations)
  backend.register('workExportForCloud', () => {
    throw new Error('Sharing is not available in the demo.')
  })
  backend.register('outboxList', () => [])
  backend.register('projectConfigLoad', (): ProjectConfig => store.projectConfig())
  backend.register('projectConfigSave', (args): ProjectConfig => store.saveProjectConfig(arg<ProjectConfig>(args, 1)))
  backend.register('detectEditors', () => ({ editors: [], terminals: [] }))
}
