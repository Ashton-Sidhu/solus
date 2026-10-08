import { expect, test } from 'bun:test'
import { asHostApi } from '@solus/client-core/host-api'
import { SessionQueueController } from '@solus/workspace-ui/contexts/workspace/session-queue.store.svelte'
import { makeSession } from '@solus/workspace-ui/contexts/workspace/session.factories'
import type { SettingsContext } from '@solus/workspace-ui/contexts/app/settings.context.svelte'
import type { SessionQueueSnapshot } from '@solus/contracts/session-queue'
import type { IpcContext } from '@solus/contracts/types'

function fixture() {
  let session = makeSession({ defaultPermissionMode: 'full-access' } as SettingsContext)
  const replies: Array<(snapshot: SessionQueueSnapshot) => void> = []
  const api = asHostApi({ sessionQueue: () => new Promise<SessionQueueSnapshot>((resolve) => { replies.push(resolve) }) })
  const controller = new SessionQueueController({
    sessionFor: () => session,
    apiFor: () => api,
    ctxFor: () => ({}) as IpcContext,
  })
  return { controller, replies, get session() { return session }, replace() { session = makeSession({ defaultPermissionMode: 'full-access' } as SettingsContext) } }
}

test('mounted queue views share both pending and completed reads for their session', async () => {
  const f = fixture()
  const first = f.controller.ensure('first-tab')
  const second = f.controller.ensure('second-tab')
  await Promise.resolve()
  expect(f.replies).toHaveLength(1)
  f.replies[0]({ held: true, entries: [] })
  await Promise.all([first, second])
  await f.controller.ensure('remounted-tab')
  expect(f.replies).toHaveLength(1)
  expect(f.session.queueHeld).toBe(true)
  f.replace()
  const next = f.controller.ensure('first-tab')
  await Promise.resolve()
  expect(f.replies).toHaveLength(2)
  f.replies[1]({ held: false, entries: [] })
  await next
})

test('reconnect refreshes read again and cannot replace a newer live queue event', async () => {
  const f = fixture()
  const first = f.controller.ensure('tab')
  await Promise.resolve()
  f.replies[0]({ held: false, entries: [] })
  await first
  const reconnect = f.controller.refresh('tab')
  await Promise.resolve()
  expect(f.replies).toHaveLength(2)
  f.session.queueVersion = 1
  f.session.queueHeld = true
  f.replies[1]({ held: false, entries: [] })
  await reconnect
  expect(f.session.queueHeld).toBe(true)
})

test('a failed initial read remains retryable', async () => {
  const session = makeSession({ defaultPermissionMode: 'full-access' } as SettingsContext)
  let calls = 0
  const api = asHostApi({ sessionQueue: async () => {
    if (++calls === 1) throw new Error('Disconnected')
    return { held: false, entries: [] }
  } })
  const controller = new SessionQueueController({ sessionFor: () => session, apiFor: () => api, ctxFor: () => ({}) as IpcContext })
  await expect(controller.ensure('tab')).rejects.toThrow('Disconnected')
  await controller.ensure('tab')
  expect(calls).toBe(2)
})
