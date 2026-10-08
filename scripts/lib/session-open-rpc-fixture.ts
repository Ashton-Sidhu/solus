import { readFileSync } from 'node:fs'
import type { SessionMeta, SessionLineageResolution } from '@solus/contracts/types'
import { INITIAL_HISTORY_TURNS, prefetchSessionHistoryPage, requestSessionHistoryPage } from '@solus/client-core/session-history-page'
import type { SessionHistoryPageRequest } from '@solus/contracts/session-history'
import { readSessionMeta, stampSessionMeta } from '@solus/client-core/session-meta'

interface SessionOpenFixtureOwner {
  settings: { activeAgent: string }
}

export interface RpcRead {
  method: string
  keys: string[]
  resolve(): void
  reject(error: Error): void
}

/** Run the production restore commands without Svelte, a host or live data.
 * Each mock RPC stays pending until the test/measurement releases it. */
export function sessionOpenRpcFixture(tabCount = 1, options: { lineage?: SessionLineageResolution } = {}) {
  const source = readFileSync(new URL('../../packages/workspace-ui/src/contexts/workspace/session-bootstrap.ts', import.meta.url), 'utf8')
  const metadataSource = source.slice(source.indexOf('function startRestoredMetadataReads('), source.indexOf('/**\n * Hydrate a single tab:'))
  const hydrationSource = source.slice(source.indexOf('async function hydrateTab('))
  const reads: RpcRead[] = []
  const historyRequests: SessionHistoryPageRequest[] = []
  const environmentReads: Array<{ sourceId: string; level?: string; force: boolean }> = []
  const transcriptIdentities: string[] = []
  const tabs = Array.from({ length: tabCount }, (_, index) => ({
    sessionId: options.lineage?.sessionId ?? `session-${index}`,
    tabId: `tab-${index}`, agentSessionId: `provider-${index}`, provider: 'codex' as const,
    serverId: index % 2 ? 'remote' : 'local', workingDirectory: '/fixture',
  }))
  type FixtureMessage = { id: string; role: string; content: string; timestamp: number }
  const sessions = tabs.map((tab) => ({
    id: tab.sessionId, agentSessionId: tab.agentSessionId,
    run: { serverId: tab.serverId, provider: 'codex' },
    messages: new Array<FixtureMessage>(),
    status: 'idle', loadingHistory: false,
  }))
  function rpc<T>(method: string, keys: string[], value: T): Promise<T> {
    return new Promise((resolve, reject) => reads.push({ method, keys, resolve: () => resolve(value), reject }))
  }
  const apis = new Map(tabs.map((tab) => [tab.serverId, {
    getSessionInfo: (key: string) => rpc<SessionMeta | null>('getSessionInfo', [key], null),
    getSessionInfos: (keys: string[]) => rpc<Array<SessionMeta | null>>('getSessionInfos', keys, keys.map(() => null)),
    describeSession: (key: string) => rpc('describeSession', [key], { lineage: options.lineage ?? null }),
    loadSessionPage: (request: SessionHistoryPageRequest) => {
      historyRequests.push(request)
      return rpc('loadSessionPage', [request.sessionId], { messages: [{ id: 'answer', role: 'assistant' as const, content: 'Ready', timestamp: 1 }], before: null })
    },
    watchSession: () => rpc('watchSession', [], { sessionId: sessions[0].id, runtime: null }),
  }]))
  const hosts = { isKnownServer: () => true, resolveId: (id: string) => id, apiFor: (id: string) => apis.get(id)! }
  const workspace = {
    tabs: Object.fromEntries(tabs.map((tab, index) => [tab.tabId, { sessionId: sessions[index].id }])),
    sessions: { byId: Object.fromEntries(sessions.map((session) => [session.id, session])) },
    sessionFor: (tabId: string) => sessions[tabs.findIndex((tab) => tab.tabId === tabId)],
    apiFor: (tabId: string) => apis.get(tabs.find((tab) => tab.tabId === tabId)!.serverId)!,
    settings: { activeAgent: 'codex' },
    environment: { refreshEnvironment: async (_workspace: SessionOpenFixtureOwner, options: { sourceId: string; level?: string; force: boolean }) => { environmentReads.push(options); return null } },
    tasksStore: { ensureSessionBinding: async () => null },
    ctxFor: (tabId: string) => ({ session: { sessionId: tabId } }),
    eventReducer: { rebuildAgentConversations: () => {} },
    planStore: { hydrateAnnotations: async () => {} },
    lifecycle: { recomputeChangedFiles: () => {}, reconcileQueuedPrompts: () => {} },
    applyPendingQuestions: () => {},
    adoptSessionId: () => {},
    refreshThreadGoal: async () => {},
  }
  const dependencies = {
    serverConnections: hosts,
    stampSessionMeta,
    readSessionMeta: (serverId: string, sessionId: string) => readSessionMeta(serverId, sessionId, hosts),
    applyRestoredSessionMeta: () => {},
    isSessionBusyStatus: () => false,
    prioritizeTabHydration: () => {},
    loadRestoredSessionTranscript: async (_workspace: typeof workspace, args: { sessionId: string; history?: Promise<{ messages: FixtureMessage[] }> }) => {
      transcriptIdentities.push(args.sessionId)
      return {
        messages: (await (args.history ?? apis.get(tabs[0].serverId)!.loadSessionPage({ sessionId: args.sessionId }))).messages,
        progress: null, truncated: false, planIds: [],
      }
    },
    replaceHydratedMessages: (session: typeof sessions[number], messages: typeof sessions[number]['messages']) => {
      session.messages.splice(0, session.messages.length, ...messages)
    },
    requestSessionHistoryPage,
    afterPaint: async () => {},
    markStartupTranscriptApplied: () => {},
    applyRuntimeConfig: () => {},
    nextMsgId: () => 'message',
    INITIAL_HISTORY_TURNS,
  }
  const compiled = new Bun.Transpiler({ loader: 'ts' }).transformSync(metadataSource + '\n' + hydrationSource)
  // SAFETY: the extracted source returns these two production functions; the
  // fixture supplies every dependency and field they read on these paths.
  const commands = new Function(...Object.keys(dependencies), compiled + '\nreturn { startRestoredMetadataReads, hydrateTab }')(...Object.values(dependencies)) as {
    startRestoredMetadataReads(ctx: typeof workspace, persistedTabs: typeof tabs, state: { hasStartedMetadataReads: boolean }): void
    hydrateTab(ctx: typeof workspace, tab: typeof tabs[number]): Promise<boolean>
  }
  return {
    reads, historyRequests, transcriptIdentities, environmentReads, session: sessions[0],
    prefetch: () => prefetchSessionHistoryPage(apis.get(tabs[0].serverId)!, {
      sessionId: tabs[0].sessionId, projectPath: tabs[0].workingDirectory,
      provider: tabs[0].provider, turnLimit: INITIAL_HISTORY_TURNS,
    }),
    close: () => { delete workspace.tabs[tabs[0].tabId]; sessions.splice(0, 1) },
    startMetadata: () => commands.startRestoredMetadataReads(workspace, tabs, { hasStartedMetadataReads: false }),
    open: () => commands.hydrateTab(workspace, tabs[0]),
  }
}

export async function flushRpcContinuations(): Promise<void> {
  // Flush promise chains only: no elapsed-time assumption or host polling.
  for (let index = 0; index < 20; index++) await Promise.resolve()
}
