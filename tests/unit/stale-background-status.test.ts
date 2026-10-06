import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'

const transpiler = new Bun.Transpiler({ loader: 'ts' })

// Background tasks live in the provider query. After a host restart no query is
// left, so a restored tab must not keep offering to stop tasks that are gone.
test.each([
  ['background', 'idle'],
  ['completed', 'completed'],
])('a restored %s tab with no live runtime settles to %s', async (restored, expected) => {
  const bootstrap = readFileSync(new URL('../../packages/workspace-ui/src/contexts/workspace/session-bootstrap.ts', import.meta.url), 'utf8')
  const hydration = transpiler.transformSync(bootstrap.slice(bootstrap.indexOf('async function hydrateTab(')))
  const session = { id: 'stable', agentSessionId: 'thread', run: { provider: 'claude-code' }, messages: [], loadingHistory: false, status: restored, rateLimitInfo: null }
  const context = {
    tabs: { tab: { sessionId: 'stable' } }, sessions: { byId: { stable: session } },
    settings: { activeAgent: 'claude-code' }, apiFor: () => ({
      resolveSessionLineage: async () => null,
      watchSession: async () => ({ sessionId: 'stable', runtime: null }),
    }),
    ctxFor: () => ({}), sessionFor: () => session,
    eventReducer: { rebuildAgentConversations() {} }, lifecycle: { recomputeChangedFiles() {}, reconcileQueuedPrompts() {} },
    planStore: { hydrateAnnotations() {} }, adoptSessionId() {}, applyPendingQuestions() {}, refreshThreadGoal() {},
    environment: { refreshEnvironment: async () => {} },
    tasksStore: { ensureSessionBinding: async () => {} },
  }
  const hydrate = new Function('afterPaint', 'requestSessionHistoryPage', 'loadRestoredSessionTranscript',
    'replaceHydratedMessages', 'markStartupTranscriptApplied', 'INITIAL_HISTORY_TURNS', 'isSessionBusyStatus',
    'serverConnections', `${hydration}\nreturn hydrateTab;`)(
    () => new Promise(() => {}), async () => ({ messages: [] }),
    async () => ({ messages: [], planIds: [] }), () => {}, () => {}, 200, () => false,
    { isKnownServer: () => true })
  await hydrate(context, { tabId: 'tab', agentSessionId: 'thread', provider: 'claude-code', workingDirectory: '/repo' })
  expect(session.status).toBe(expected)
})
