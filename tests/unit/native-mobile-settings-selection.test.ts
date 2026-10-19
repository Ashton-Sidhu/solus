import { describe, expect, test } from 'bun:test'
import { NOTIFICATION_CHANNELS, SESSION_NOTIFICATION_EVENTS } from '@solus/contracts/notification-types'
import type { PersonalSettings } from '@solus/contracts/settings'
import { PersonalSettingsStore } from '../../apps/mobile/src/features/settings/personal-settings'
import { memoryKeyValueStore } from '../../apps/mobile/src/platform/ports'

// The Notifications and Agent defaults screens read the personal settings
// through useSyncExternalStore, which re-renders a reader when its answer is
// not Object.is the last one (pingdotgg/t3code#20848). Every write rebuilds the
// whole settings value, so a reader of the whole value re-renders on any write;
// a reader of one primitive re-renders only when that value changes.

type Reader = (settings: PersonalSettings) => unknown

/** How many times each reader would re-render across the writes. */
function rendersAcross(readers: Readonly<Record<string, Reader>>, writes: ReadonlyArray<(store: PersonalSettingsStore) => void>) {
  const store = new PersonalSettingsStore(memoryKeyValueStore())
  const counts = Object.fromEntries(Object.keys(readers).map((name) => [name, 0]))
  let last = Object.fromEntries(Object.entries(readers).map(([name, read]) => [name, read(store.current())]))
  for (const write of writes) {
    write(store)
    const next = Object.fromEntries(Object.entries(readers).map(([name, read]) => [name, read(store.current())]))
    for (const name of Object.keys(readers)) if (!Object.is(last[name], next[name])) counts[name]! += 1
    last = next
  }
  return counts
}

const unrelatedWrites = [
  (store: PersonalSettingsStore) => store.set({ themeMode: 'dark' }),
  (store: PersonalSettingsStore) => store.applyRemote({ set: { extraInstructions: 'from another device' }, reset: [] }),
]

describe('settings screens read only what they show', () => {
  test('an unrelated write re-renders a whole-value reader but no selected value', () => {
    const before = rendersAcross({ wholeValue: (settings) => settings }, unrelatedWrites)
    const notificationRows = Object.fromEntries([
      ...NOTIFICATION_CHANNELS.map((channel) => [`channel:${channel}`, (settings: PersonalSettings) => settings.notifications.channels[channel]]),
      ...SESSION_NOTIFICATION_EVENTS.map((event) => [`event:${event}`, (settings: PersonalSettings) => settings.notifications.events[event]]),
    ])
    const agentDefaults: Record<string, Reader> = {
      activeAgent: (settings) => settings.activeAgent,
      defaultModel: (settings) => settings.defaultModels[settings.activeAgent] ?? null,
      defaultPermissionMode: (settings) => settings.defaultPermissionMode,
      responseStreamingMode: (settings) => settings.responseStreamingMode,
      rateLimitBehavior: (settings) => settings.rateLimitBehavior,
      autoRenameSessions: (settings) => settings.autoRenameSessions,
    }
    const after = rendersAcross({ ...notificationRows, ...agentDefaults }, unrelatedWrites)
    console.log(JSON.stringify({ probe: 'personal-settings-unrelated-writes', writes: unrelatedWrites.length, before, afterTotal: Object.values(after).reduce((sum, count) => sum + count, 0), selectedReaders: Object.keys(after).length }))
    expect(before.wholeValue).toBe(2)
    expect(Object.values(after).every((count) => count === 0)).toBe(true)
  })

  test('turning one switch re-renders that row alone', () => {
    const [channel, other] = NOTIFICATION_CHANNELS
    const counts = rendersAcross(
      {
        changed: (settings) => settings.notifications.channels[channel!],
        other: (settings) => settings.notifications.channels[other!],
      },
      [(store) => {
        const next = structuredClone(store.current().notifications)
        next.channels[channel!] = !next.channels[channel!]
        store.set({ notifications: next })
      }],
    )
    expect(counts).toEqual({ changed: 1, other: 0 })
  })
})
