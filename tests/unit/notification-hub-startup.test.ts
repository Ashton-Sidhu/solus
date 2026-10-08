import { afterEach, expect, mock, spyOn, test } from 'bun:test'
import { NotificationHubClient } from '@solus/client-core/notifications/hub-client'

mock.module('@solus/workspace-ui/contexts/connections/servers.store.svelte', () => ({ serversStore: { servers: [], workspaces: [] } }))
mock.module('svelte-sonner', () => ({ toast: Object.assign(() => '', { success: () => '', error: () => '', dismiss: () => {} }) }))

const runtime = globalThis as typeof globalThis & {
  $state?: { <T>(value: T): T; snapshot<T>(value: T): T }
  $effect?: { (effect: () => void): void; root(effect: () => void): () => void }
}
const previousState = runtime.$state
const previousEffect = runtime.$effect
const previousDocument = globalThis.document

afterEach(() => {
  mock.restore()
  if (previousState) runtime.$state = previousState
  else delete runtime.$state
  if (previousEffect) runtime.$effect = previousEffect
  else delete runtime.$effect
  Object.defineProperty(globalThis, 'document', { value: previousDocument, configurable: true })
})

test('notification startup waits for the account before reading host capabilities', async () => {
  runtime.$state = Object.assign(<T>(value: T) => value, { snapshot: <T>(value: T) => value })
  let update!: () => void
  runtime.$effect = Object.assign((effect: () => void) => { update = effect; effect() }, {
    root: (effect: () => void) => { effect(); return () => {} },
  })
  Object.defineProperty(globalThis, 'document', { value: {
    addEventListener: () => {}, removeEventListener: () => {}, visibilityState: 'visible', hasFocus: () => false,
  }, configurable: true })
  const { accountStore } = await import('@solus/workspace-ui/contexts/account/account.store.svelte')
  const { notificationHubStore } = await import('@solus/workspace-ui/contexts/notifications/notification-hub.store.svelte')
  spyOn(accountStore, 'start').mockImplementation(() => {})
  const previousAnswered = accountStore.hasAnswered
  accountStore.hasAnswered = false
  const reads = spyOn(NotificationHubClient.prototype, 'setSources').mockImplementation(() => {})
  const stop = notificationHubStore.start()
  try {
    expect(reads).not.toHaveBeenCalled()
    accountStore.hasAnswered = true
    update()
    expect(reads).toHaveBeenCalledTimes(1)
    update()
    expect(reads).toHaveBeenCalledTimes(2)
    // A stable account keeps the same engine; its sources are idempotent.
    expect(reads.mock.contexts[0]).toBe(reads.mock.contexts[1])
  } finally {
    stop()
    accountStore.hasAnswered = previousAnswered
  }
})
