import { expect, mock, spyOn, test } from 'bun:test'

const bootstrapRuntimeTabs = mock(async () => {})

mock.module('@solus/workspace-ui/contexts/workspace/session-bootstrap', () => ({
  bootstrapRuntimeTabs,
}))

import { serverConnections } from '@solus/client-core/server-connections'

const { initializeRuntime, refreshRuntime } = await import('@solus/workspace-ui/contexts/app/runtime-boot')

test('restores persisted sessions without waiting for static host metadata', async () => {
  // WHY: start() can be slow or fail while a host connection is coming up. The
  // selected tab already exists from local storage, so its transcript must begin
  // loading immediately instead of falling back to an empty conversation.
  let finishStaticInfo!: () => void
  const staticInfo = new Promise<void>((resolve) => {
    finishStaticInfo = resolve
  })
  const loadPinnedSessions = mock(async () => {})

  const stop = initializeRuntime(
    { initStaticInfo: () => staticInfo } as never,
    { loadPinnedSessions } as never,
  )

  await Promise.resolve()
  expect(bootstrapRuntimeTabs).toHaveBeenCalledTimes(1)
  expect(loadPinnedSessions).toHaveBeenCalledTimes(1)

  finishStaticInfo()
  stop()
})

test('reconnect refreshes do not register more app listeners, and unmount releases them', () => {
  const stopConnections = mock(() => {})
  const stopPhases = mock(() => {})
  const connections = spyOn(serverConnections, 'onConnectionCreated').mockReturnValue(stopConnections)
  const phases = spyOn(serverConnections, 'onPhaseChange').mockReturnValue(stopPhases)
  // SAFETY: bootstrap is mocked above; these are the only workspace and sidebar methods this test calls.
  const workspace = { initStaticInfo: async () => {} } as Parameters<typeof initializeRuntime>[0]
  // SAFETY: the fixture covers the one sidebar command called by initialization and refresh.
  const sidebar = { loadPinnedSessions: async () => {} } as Parameters<typeof initializeRuntime>[1]
  try {
    const stop = initializeRuntime(workspace, sidebar)
    refreshRuntime(workspace, sidebar)
    refreshRuntime(workspace, sidebar)
    expect(connections).toHaveBeenCalledTimes(1)
    expect(phases).toHaveBeenCalledTimes(1)
    stop()
    expect(stopConnections).toHaveBeenCalledTimes(1)
    expect(stopPhases).toHaveBeenCalledTimes(1)
  } finally {
    connections.mockRestore()
    phases.mockRestore()
  }
})
