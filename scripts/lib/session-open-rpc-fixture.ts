import { readFileSync } from 'node:fs'
import type { SessionMeta, SessionLineageResolution } from '@solus/contracts/types'
import { readSessionMeta, stampSessionMeta } from '@solus/client-core/session-meta'

export interface RpcRead {
  method: string
  keys: string[]
  resolve(): void
  reject(error: Error): void
}

/** Run the production restore commands without Svelte, a host or live data.
 * Each mock RPC stays pending until the test/measurement releases it. */
export function sessionOpenRpcFixture(tabCount = 1, options: { lineage?: SessionLineageResolution; deferToolInputs?: boolean } = {}) {
  const source = readFileSync(new URL('../../packages/workspace-ui/src/contexts/workspace/session-bootstrap.ts', import.meta.url), 'utf8')
  const metadataSource = source.slice(source.indexOf('function startRestoredMetadataReads('), source.indexOf('/**\n * Hydrate a single tab:'))
  const hydrationSource = source.slice(source.indexOf('async function hydrateTab('))
  const reads: RpcRead[] = []
  const historyRequests: Array<{ sessionId: string; limit?: number; deferToolInputs?: boolean }> = []
  const transcriptIdentities: string[] = []
  const tabs = Array.from({ length: tabCount }, (_, index) => ({
    tabId: `tab-${index}`, agentSessionId: `provider-${index}`, provider: 'codex',
    serverId: index % 2 ? 'remote' : 'local', workingDirectory: '/fixture',
  }))
  type FixtureMessage = { id: string; role: string; content: string; timestamp: number }
  const sessions = tabs.map((tab, index) => ({
    id: `session-${index}`, agentSessionId: tab.agentSessionId,
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
    resolveSessionLineage: (_provider: string, key: string) => rpc('resolveSessionLineage', [key], options.lineage ?? null),
    loadSession: (key: string, _path?: string, _context?: { session: { sessionId: string } }, _provider?: string, limit?: number, loadOptions?: { deferToolInputs?: boolean }) => {
      historyRequests.push({ sessionId: key, limit, deferToolInputs: loadOptions?.deferToolInputs })
      return rpc('loadSession', [key], [{ id: 'answer', role: 'assistant', content: 'Ready', timestamp: 1 }])
    },
    watchSession: () => rpc('watchSession', [], { sessionId: sessions[0].id, runtime: null }),
  }]))
  const hosts = { resolveId: (id: string) => id, apiFor: (id: string) => apis.get(id)! }
  const workspace = {
    tabs: Object.fromEntries(tabs.map((tab, index) => [tab.tabId, { sessionId: sessions[index].id }])),
    sessions: Object.fromEntries(sessions.map((session) => [session.id, session])),
    sessionFor: (tabId: string) => sessions[tabs.findIndex((tab) => tab.tabId === tabId)],
    apiFor: (tabId: string) => apis.get(tabs.find((tab) => tab.tabId === tabId)!.serverId)!,
    settings: { activeAgent: 'codex' },
    deferHistoryToolInputs: options.deferToolInputs,
    environment: { refreshEnvironment: async () => null },
    tasksStore: { ensureSessionBinding: async () => null },
    ctxFor: (tabId: string) => ({ session: { sessionId: tabId } }),
    eventReducer: { rebuildAgentConversations: () => {} },
    planStore: { hydrateAnnotations: async () => {} },
    recomputeChangedFiles: () => {},
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
    loadRestoredSessionTranscript: async (_workspace: typeof workspace, args: { sessionId: string; history?: Promise<typeof sessions[number]['messages']> }) => {
      transcriptIdentities.push(args.sessionId)
      return {
        messages: await (args.history ?? apis.get(tabs[0].serverId)!.loadSession(args.sessionId)),
        progress: null, truncated: false, planIds: [],
      }
    },
    replaceHydratedMessages: (session: typeof sessions[number], messages: typeof sessions[number]['messages']) => {
      session.messages.splice(0, session.messages.length, ...messages)
    },
    applyRuntimeConfig: () => {},
    nextMsgId: () => 'message',
    RESTORED_TRANSCRIPT_LIMIT: 200,
  }
  const compiled = new Bun.Transpiler({ loader: 'ts' }).transformSync(metadataSource + '\n' + hydrationSource)
  // SAFETY: the extracted source returns these two production functions; the
  // fixture supplies every dependency and field they read on these paths.
  const commands = new Function(...Object.keys(dependencies), compiled + '\nreturn { startRestoredMetadataReads, hydrateTab }')(...Object.values(dependencies)) as {
    startRestoredMetadataReads(ctx: typeof workspace, persistedTabs: typeof tabs, state: { hasStartedMetadataReads: boolean }): void
    hydrateTab(ctx: typeof workspace, tab: typeof tabs[number]): Promise<boolean>
  }
  return {
    reads, historyRequests, transcriptIdentities, session: sessions[0],
    close: () => { delete workspace.tabs[tabs[0].tabId]; sessions.splice(0, 1) },
    startMetadata: () => commands.startRestoredMetadataReads(workspace, tabs, { hasStartedMetadataReads: false }),
    open: () => commands.hydrateTab(workspace, tabs[0]),
  }
}

export async function flushRpcContinuations(): Promise<void> {
  // Flush promise chains only: no elapsed-time assumption or host polling.
  for (let index = 0; index < 20; index++) await Promise.resolve()
}
