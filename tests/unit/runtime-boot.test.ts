import { expect, mock, test } from 'bun:test'

const bootstrapRuntimeTabs = mock(async () => {})

mock.module('../../src/renderer/contexts/workspace/session-bootstrap', () => ({
  bootstrapRuntimeTabs,
}))

const { initializeRuntime } = await import('../../src/renderer/contexts/app/runtime-boot')

test('restores persisted sessions without waiting for static host metadata', async () => {
  // WHY: start() can be slow or fail while a host connection is coming up. The
  // selected tab already exists from local storage, so its transcript must begin
  // loading immediately instead of falling back to an empty conversation.
  let finishStaticInfo!: () => void
  const staticInfo = new Promise<void>((resolve) => {
    finishStaticInfo = resolve
  })
  const loadPinnedSessions = mock(async () => {})

  initializeRuntime(
    { initStaticInfo: () => staticInfo } as never,
    { loadPinnedSessions } as never,
  )

  await Promise.resolve()
  expect(bootstrapRuntimeTabs).toHaveBeenCalledTimes(1)
  expect(loadPinnedSessions).toHaveBeenCalledTimes(1)

  finishStaticInfo()
})
