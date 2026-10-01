import { afterAll, afterEach, expect, mock, test } from 'bun:test'
import type { BrowserNotificationPermission as BrowserNotificationPermissionType } from '@solus/workspace-ui/components/settings/lib/browser-notification-permission.svelte'
import { SvelteRunes } from './helpers/svelte-runes'

const tracked = mock((_event: string, _props: { granted: boolean }) => {})
const testGlobals = globalThis as typeof globalThis & { __trackPermission?: typeof tracked }
testGlobals.__trackPermission = tracked

const runes = new SvelteRunes()
afterAll(() => runes.dispose())
const analytics = runes.module('analytics', 'export const track = (...args) => globalThis.__trackPermission(...args)')
const { BrowserNotificationPermission } = (await import(runes.source(
  'browser-notification-permission',
  'packages/workspace-ui/src/components/settings/lib/browser-notification-permission.svelte.ts',
  { '../../../lib/analytics': analytics },
))) as { BrowserNotificationPermission: typeof BrowserNotificationPermissionType }

const original = globalThis.Notification
afterEach(() => {
  globalThis.Notification = original
  tracked.mockClear()
})

function stubNotification(permission: NotificationPermission, answer: NotificationPermission = permission) {
  const requestPermission = mock(async () => answer)
  globalThis.Notification = { permission, requestPermission } as unknown as typeof Notification
  return requestPermission
}

// The "System alert" switch is shared by every client of a host, so a browser
// that never granted permission must say so and offer to ask, not look on.
test('an ungranted browser explains why the shared switch delivers nothing', () => {
  stubNotification('default')
  const permission = new BrowserNotificationPermission()
  expect(permission.systemAlertDescription(true, 'A notification.')).toContain('Allow notifications')
  expect(permission.systemAlertDescription(false, 'A notification.')).toBe('A notification.')

  stubNotification('denied')
  expect(new BrowserNotificationPermission().systemAlertDescription(true, 'A notification.')).toContain('blocked')

  stubNotification('granted')
  expect(new BrowserNotificationPermission().systemAlertDescription(true, 'A notification.')).toBe('A notification.')
})

test('the browser is asked once, only while undecided', async () => {
  const ask = stubNotification('default', 'granted')
  const permission = new BrowserNotificationPermission()
  await permission.request()
  await permission.request()
  expect(ask).toHaveBeenCalledTimes(1)
  expect(permission.state).toBe('granted')
  expect(tracked).toHaveBeenCalledWith('push_permission_result', { granted: true })

  const denied = stubNotification('denied')
  await new BrowserNotificationPermission().request()
  expect(denied).not.toHaveBeenCalled()
})

test('a shell without the Notification API has nothing to ask', async () => {
  globalThis.Notification = undefined as unknown as typeof Notification
  const permission = new BrowserNotificationPermission()
  expect(permission.state).toBeNull()
  await permission.request()
  expect(permission.systemAlertDescription(true, 'A notification.')).toBe('A notification.')
})
