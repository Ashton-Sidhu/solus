import { describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  APP_NOTICE_EVENTS,
  DEFAULT_NOTIFICATION_PREFERENCES,
  NOTIFICATION_EVENTS,
  SESSION_NOTIFICATION_EVENTS,
  mergeNotificationPreferences,
  notificationEventForAttentionKind,
  notificationEventForSoundTrigger,
  shouldDeliverNotification,
  type NotificationSoundTrigger,
} from '@solus/contracts/notification-types'
import {
  DELIVERY_SITUATIONS,
  NOTIFICATION_CHANNEL_ROWS,
  SESSION_EVENT_ROWS,
  notificationRowMatches,
  notificationSettingsCoverContract,
} from '@solus/workspace-ui/components/settings/lib/notification-settings'

type SettingsModule = typeof import('@solus/server/server/settings')

describe('notification preferences', () => {
  test('a notification needs both its channel and its event on', () => {
    // Two switches, one gate: turning an event off silences it on every
    // channel, and turning a channel off silences every event on it.
    const preferences = mergeNotificationPreferences(DEFAULT_NOTIFICATION_PREFERENCES, {
      channels: { sound: true, system: false },
      events: { question: false },
    })
    expect(shouldDeliverNotification(preferences, 'sound', 'needs_approval')).toBe(true)
    expect(shouldDeliverNotification(preferences, 'sound', 'question')).toBe(false)
    expect(shouldDeliverNotification(preferences, 'system', 'needs_approval')).toBe(false)
  })

  test('every channel off is "none" for session events', () => {
    const preferences = mergeNotificationPreferences(DEFAULT_NOTIFICATION_PREFERENCES, {
      channels: { sound: false, toast: false, system: false },
    })
    for (const event of SESSION_NOTIFICATION_EVENTS) {
      expect(shouldDeliverNotification(preferences, 'sound', event)).toBe(false)
      expect(shouldDeliverNotification(preferences, 'toast', event)).toBe(false)
      expect(shouldDeliverNotification(preferences, 'system', event)).toBe(false)
    }
  })

  test('an app notice has an event switch and is on by default', () => {
    // The toast channel defaults off (it replaced `backgroundActivityToasts`),
    // so an app notice must not hang off it or every update prompt would
    // vanish on upgrade. Each has its own switch, and each starts on.
    for (const event of APP_NOTICE_EVENTS) {
      expect(NOTIFICATION_EVENTS).toContain(event)
      expect(DEFAULT_NOTIFICATION_PREFERENCES.events[event]).toBe(true)
    }
    expect(APP_NOTICE_EVENTS).toEqual([
      'review_guide_ready', 'review_lens_ready', 'update_available', 'host_discovered', 'teammate_presence', 'share_revoked',
    ])
  })

  test('merge does not alias the defaults', () => {
    // The settings context wraps the result in a `$state` proxy and mutates it
    // in place; sharing the constant would let one switch rewrite the defaults.
    const merged = mergeNotificationPreferences(DEFAULT_NOTIFICATION_PREFERENCES, {})
    expect(merged).toEqual(DEFAULT_NOTIFICATION_PREFERENCES)
    expect(merged.channels).not.toBe(DEFAULT_NOTIFICATION_PREFERENCES.channels)
    expect(merged.events).not.toBe(DEFAULT_NOTIFICATION_PREFERENCES.events)
  })

  test('every sound trigger and attention kind lands on one event switch', () => {
    // A source that maps to no event could never be turned off.
    const triggers: NotificationSoundTrigger[] = [
      'turn_settled', 'permission_request', 'question_request', 'plan', 'work_created',
      'artifact_created', 'automation_saved', 'task_created',
      'agent_conversation_new_card', 'agent_conversation_needs_attention',
    ]
    for (const trigger of triggers) {
      expect(SESSION_NOTIFICATION_EVENTS).toContain(notificationEventForSoundTrigger(trigger))
    }
    expect(notificationEventForAttentionKind('needs_approval')).toBe('needs_approval')
    expect(notificationEventForAttentionKind('question')).toBe('question')
    expect(notificationEventForAttentionKind('failed')).toBe('session_failed')
    expect(notificationEventForAttentionKind('finished')).toBe('turn_finished')
    // The attention entry and the sound trigger for the same moment agree.
    expect(notificationEventForSoundTrigger('permission_request')).toBe(notificationEventForAttentionKind('needs_approval'))
    expect(notificationEventForSoundTrigger('turn_settled')).toBe(notificationEventForAttentionKind('finished'))
  })
})

describe('the Notifications settings page', () => {
  test('has a switch for every channel, session event, and app notice in the contract', () => {
    // A new event added to the contract without a row here would notify with
    // no way to turn it off.
    expect(notificationSettingsCoverContract()).toBe(true)
  })

  test('every channel sits under exactly one situation, and no situation is empty', () => {
    // The page states the condition once per group. A channel with no
    // situation would need its own "when" clause again; an empty group is a
    // heading over nothing.
    const situations = new Set(DELIVERY_SITUATIONS.map((situation) => situation.id))
    for (const row of NOTIFICATION_CHANNEL_ROWS) expect(situations.has(row.situation)).toBe(true)
    for (const situation of DELIVERY_SITUATIONS) {
      expect(NOTIFICATION_CHANNEL_ROWS.some((row) => row.situation === situation.id)).toBe(true)
    }
    expect(NOTIFICATION_CHANNEL_ROWS.find((row) => row.id === 'toast')?.situation).toBe('in_front')
    expect(NOTIFICATION_CHANNEL_ROWS.find((row) => row.id === 'sound')?.situation).toBe('in_background')
    expect(NOTIFICATION_CHANNEL_ROWS.find((row) => row.id === 'system')?.situation).toBe('in_background')
  })

  test('search matches a row by label or keyword', () => {
    const approval = SESSION_EVENT_ROWS.find((row) => row.id === 'needs_approval')!
    expect(notificationRowMatches(approval, 'permission')).toBe(true)
    expect(notificationRowMatches(approval, 'Needs')).toBe(true)
    expect(notificationRowMatches(approval, 'diagram')).toBe(false)
    expect(notificationRowMatches(approval, '')).toBe(true)
  })
})

describe('the flags notifications replaced', () => {
  test('a host that stored soundEnabled=false keeps sound and system alerts off', async () => {
    // `soundEnabled` gated both. A user who turned it off must not get a sound
    // and a system alert back because the key changed shape.
    const legacyDir = mkdtempSync(join(tmpdir(), 'solus-legacy-notifications-'))
    writeFileSync(join(legacyDir, 'server-settings.json'), JSON.stringify({
      hostConfig: { soundEnabled: false, backgroundActivityToasts: true, fontSize: 14 },
    }))

    const previous = process.env.SOLUS_DATA_DIR
    process.env.SOLUS_DATA_DIR = legacyDir
    try {
      const legacySettings = await import(
        `@solus/server/server/settings?notifications=${Date.now()}`
      ) as SettingsModule
      const { config, seeded } = legacySettings.getHostConfig()

      expect(seeded).toBe(true)
      expect(config.notifications.channels).toEqual({ sound: false, toast: true, system: false })
      expect(config.fontSize).toBe(14)
    } finally {
      if (previous === undefined) delete process.env.SOLUS_DATA_DIR
      else process.env.SOLUS_DATA_DIR = previous
      rmSync(legacyDir, { recursive: true, force: true })
    }
  })
})
