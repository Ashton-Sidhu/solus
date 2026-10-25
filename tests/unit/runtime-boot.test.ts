import { expect, mock, spyOn, test } from 'bun:test'

const bootstrapRuntimeTabs = mock(async () => {})

mock.module('@solus/workspace-ui/contexts/workspace/session-bootstrap', () => ({
  bootstrapRuntimeTabs,
  prioritizeTabHydration: () => {},
}))
// The stall toasts have their own test (host-stall-notice.test.ts); here they only add a listener.
mock.module('@solus/workspace-ui/contexts/connections/host-stall-toasts', () => ({
  startHostStallToasts: () => () => {},
}))

import { serverConnections } from '@solus/client-core/server-connections'

const { initializeRuntime, refreshRuntime } = await import('@solus/workspace-ui/contexts/app/runtime-boot')

test('restores persisted sessions without waiting for the host\'s machine facts', async () => {
  // WHY: start() can be slow or fail while a host connection is coming up. The
  // selected tab already exists from local storage, so its transcript must begin
  // loading immediately instead of falling back to an empty conversation.
  let finishAgents!: () => void
  const agents = new Promise<void>((resolve) => {
    finishAgents = resolve
  })
  const loadPinnedSessions = mock(async () => {})

  const stop = initializeRuntime(
    { lifecycle: { readRunOnAgents: () => agents }, settings: { lastProject: null }, unstartedSourceIds: () => [], tabOrder: [] } as never,
    { loadPinnedSessions } as never,
  )

  await Promise.resolve()
  expect(bootstrapRuntimeTabs).toHaveBeenCalledTimes(1)
  expect(loadPinnedSessions).toHaveBeenCalledTimes(1)

  finishAgents()
  stop()
})

test('reconnect refreshes do not register more app listeners, and unmount releases them', () => {
  const stopConnections = mock(() => {})
  const stopReadiness = mock(() => {})
  const connections = spyOn(serverConnections, 'onConnectionCreated').mockReturnValue(stopConnections)
  const readiness = spyOn(serverConnections, 'onReadinessChange').mockReturnValue(stopReadiness)
  // SAFETY: bootstrap is mocked above; these are the only workspace and sidebar
  // members this test reaches (the gone-machine pass reads the last two).
  const workspace = { lifecycle: { readRunOnAgents: async () => {} }, settings: { lastProject: null }, unstartedSourceIds: () => [], tabOrder: [] } as unknown as Parameters<typeof initializeRuntime>[0]
  // SAFETY: the fixture covers the one sidebar command called by initialization and refresh.
  const sidebar = { loadPinnedSessions: async () => {} } as Parameters<typeof initializeRuntime>[1]
  try {
    const stop = initializeRuntime(workspace, sidebar)
    refreshRuntime(workspace, sidebar)
    refreshRuntime(workspace, sidebar)
    expect(connections).toHaveBeenCalledTimes(1)
    expect(readiness).toHaveBeenCalledTimes(1)
    stop()
    expect(stopConnections).toHaveBeenCalledTimes(1)
    expect(stopReadiness).toHaveBeenCalledTimes(1)
  } finally {
    connections.mockRestore()
    readiness.mockRestore()
  }
})

test('a host that is ready again reloads the conversations shown on screen', () => {
  // WHY: a transcript read fails at once while its host is unreachable
  // (docs/plans/host-readiness.md). Without a read when the host is back, the
  // conversation would stay on the host-away page after the host answered.
  let onReady!: (serverId: string, readiness: 'ready' | 'unreachable', attempt: number) => void
  const readiness = spyOn(serverConnections, 'onReadinessChange').mockImplementation((listener) => {
    onReady = listener
    return () => {}
  })
  const loadShownConversations = mock(() => {})
  // SAFETY: bootstrap and the outbox are not reached by these members' callers; the ready handler reads only these.
  const workspace = {
    lifecycle: { readRunOnAgents: async () => {} },
    settings: { lastProject: null },
    unstartedSourceIds: () => [],
    tabOrder: [],
    drafts: { rereadStartTargets: () => {} },
    dispatch: { redeliverOutboxPrompt: async () => {} },
    loadShownConversations,
  } as unknown as Parameters<typeof initializeRuntime>[0]
  try {
    const stop = initializeRuntime(workspace, { loadPinnedSessions: async () => {} } as never)
    onReady('raiders', 'unreachable', 3)
    expect(loadShownConversations).not.toHaveBeenCalled()
    onReady('raiders', 'ready', 0)
    expect(loadShownConversations).toHaveBeenCalledTimes(1)
    stop()
  } finally {
    readiness.mockRestore()
  }
})
