import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  PushNotificationService,
  attentionEntryKey,
  diffNewPushAttentionEntries,
} from '../../src/main/notifications/push-service'
import type { PushSender } from '../../src/main/notifications/push-service'
import type { AttentionEntry } from '../../src/shared/attention-types'
import type { WebPushSubscriptionJSON } from '../../src/shared/types'

function subscription(endpoint: string): WebPushSubscriptionJSON {
  return {
    endpoint,
    keys: {
      p256dh: `p256dh-${endpoint}`,
      auth: `auth-${endpoint}`,
    },
  }
}

function entry(sessionId: string, kind: AttentionEntry['kind'], summary = 'Needs attention'): AttentionEntry {
  return { sessionId, kind, summary, since: 1000 }
}

describe('PushNotificationService', () => {
  let dir: string
  let keysPath: string
  let subscriptionsPath: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'solus-push-'))
    keysPath = join(dir, 'state', 'push-keys.json')
    subscriptionsPath = join(dir, 'state', 'push-subscriptions.json')
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  test('stores VAPID keys and subscriptions across a restart', () => {
    const svc = new PushNotificationService({
      keysPath,
      subscriptionsPath,
      keyGenerator: () => ({ publicKey: 'public-key', privateKey: 'private-key' }),
    })

    svc.subscribe('phone-1', 'Phone', subscription('https://push.example/one'))

    expect(svc.getPublicKey()).toBe('public-key')
    expect(existsSync(keysPath)).toBe(true)
    expect(statSync(keysPath).mode & 0o777).toBe(0o600)

    const raw = JSON.parse(readFileSync(subscriptionsPath, 'utf8'))
    expect(Object.keys(raw.subscriptions)).toEqual(['phone-1'])

    const restarted = new PushNotificationService({
      keysPath,
      subscriptionsPath,
      keyGenerator: () => { throw new Error('should load existing keys') },
    })

    expect(restarted.getPublicKey()).toBe('public-key')
    expect(restarted.listSubscriptions()).toEqual([
      {
        deviceId: 'phone-1',
        deviceLabel: 'Phone',
        subscription: subscription('https://push.example/one'),
        createdAt: expect.any(Number),
      },
    ])
  })

  test('diffs full attention snapshots into newly created pushable entries', () => {
    let previous = new Set<string>([attentionEntryKey(entry('s1', 'question'))])

    const first = diffNewPushAttentionEntries(previous, [
      entry('s1', 'question'),
      entry('s2', 'finished'),
      entry('s3', 'failed'),
    ])
    expect(first.created.map((e) => `${e.sessionId}:${e.kind}`)).toEqual(['s3:failed'])

    previous = first.nextKeys
    const resolved = diffNewPushAttentionEntries(previous, [])
    previous = resolved.nextKeys

    const reappeared = diffNewPushAttentionEntries(previous, [entry('s1', 'question')])
    expect(reappeared.created.map((e) => `${e.sessionId}:${e.kind}`)).toEqual(['s1:question'])
  })

  test('sends only to offline subscriptions and drops dead subscriptions', async () => {
    const calls: Array<{ endpoint: string; payload: unknown }> = []
    const sender: PushSender = async (sub, payload) => {
      calls.push({ endpoint: sub.endpoint, payload: JSON.parse(payload) })
      if (sub.endpoint.endsWith('/dead')) throw { statusCode: 410 }
      return { statusCode: 201, body: '', headers: {} }
    }
    const svc = new PushNotificationService({
      keysPath,
      subscriptionsPath,
      sender,
      keyGenerator: () => ({ publicKey: 'public-key', privateKey: 'private-key' }),
    })
    svc.subscribe('online', 'Laptop', subscription('https://push.example/online'))
    svc.subscribe('dead', 'Old Phone', subscription('https://push.example/dead'))
    svc.subscribe('offline', 'Phone', subscription('https://push.example/offline'))

    const stats = await svc.sendToOfflineDevices(
      entry('session-1', 'needs_approval', 'Approve Bash'),
      (deviceId) => deviceId === 'online',
    )

    expect(stats).toEqual({ attempted: 2, sent: 1, dropped: 1 })
    expect(calls.map((c) => c.endpoint)).toEqual([
      'https://push.example/dead',
      'https://push.example/offline',
    ])
    expect(calls.at(-1)?.payload).toEqual({
      title: 'Solus - needs approval',
      body: 'Approve Bash',
      sessionId: 'session-1',
      kind: 'needs_approval',
    })
    expect(svc.listSubscriptions().map((s) => s.deviceId).sort()).toEqual(['offline', 'online'])

    const raw = JSON.parse(readFileSync(subscriptionsPath, 'utf8'))
    expect(Object.keys(raw.subscriptions).sort()).toEqual(['offline', 'online'])
  })
})
