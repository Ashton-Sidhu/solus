import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'
import * as webpush from 'web-push'
import { dataDir } from '../platform/paths'
import { createLogger } from '../logger'
import type { PushSubscription, RequestOptions, SendResult, VapidKeys } from 'web-push'
import {
  attentionEntryKey,
  isNotifiableAttentionEntry,
  payloadForAttentionEntry,
  type AttentionNotificationPayload,
} from '../../shared/notification-types'
import type { AttentionEntry } from '../../shared/attention-types'
import type { WebPushSubscriptionJSON } from '../../shared/types'
import { z } from 'zod'

const log = createLogger('notifications', 'push-service.ts')

function defaultKeysPath(): string {
  return join(dataDir(), 'state', 'push-keys.json')
}

function defaultSubscriptionsPath(): string {
  return join(dataDir(), 'state', 'push-subscriptions.json')
}

export interface PushSubscriptionRecord {
  deviceId: string
  deviceLabel: string
  subscription: WebPushSubscriptionJSON
  createdAt: number
}

interface PushKeysFile {
  version: 1
  publicKey: string
  privateKey: string
}

const webPushSubscriptionSchema = z.object({
  endpoint: z.string(),
  expirationTime: z.number().nullable().optional(),
  keys: z.object({ p256dh: z.string(), auth: z.string() }).strict(),
}).strict()

const pushKeysFileSchema = z.object({
  version: z.literal(1),
  publicKey: z.string(),
  privateKey: z.string(),
}).strict()

const pushSubscriptionRecordSchema = z.object({
  deviceId: z.string().min(1),
  deviceLabel: z.string(),
  subscription: webPushSubscriptionSchema,
  createdAt: z.number(),
}).strict()

const pushSubscriptionsFileSchema = z.object({
  version: z.literal(1),
  subscriptions: z.record(z.string(), pushSubscriptionRecordSchema),
}).strict()

export type PushNotificationPayload = AttentionNotificationPayload

export interface PushSendStats {
  attempted: number
  sent: number
  dropped: number
}

export type PushSender = (
  subscription: PushSubscription,
  payload: string,
  options: RequestOptions,
) => Promise<SendResult>

export interface PushNotificationServiceOptions {
  keysPath?: string
  subscriptionsPath?: string
  sender?: PushSender
  keyGenerator?: () => VapidKeys
  vapidSubject?: string
}

export { attentionEntryKey, payloadForAttentionEntry }

interface PushAttentionDiff {
  created: AttentionEntry[]
  nextKeys: Set<string>
}

export function diffNewPushAttentionEntries(
  previousKeys: ReadonlySet<string>,
  entries: AttentionEntry[],
): PushAttentionDiff {
  const nextKeys = new Set<string>()
  const created: AttentionEntry[] = []

  for (const entry of entries) {
    const key = attentionEntryKey(entry)
    nextKeys.add(key)

    // Finished entries are useful in the attention inbox but too noisy for push.
    if (!isNotifiableAttentionEntry(entry)) continue
    if (!previousKeys.has(key)) created.push(entry)
  }

  return { created, nextKeys }
}

export class PushNotificationService {
  private readonly keysPath: string
  private readonly subscriptionsPath: string
  private readonly sender: PushSender
  private readonly keyGenerator: () => VapidKeys
  private readonly vapidSubject: string
  private readonly keys: VapidKeys
  private subscriptions = new Map<string, PushSubscriptionRecord>()

  constructor(options: PushNotificationServiceOptions = {}) {
    this.keysPath = options.keysPath ?? defaultKeysPath()
    this.subscriptionsPath = options.subscriptionsPath ?? defaultSubscriptionsPath()
    this.sender = options.sender ?? webpush.sendNotification
    this.keyGenerator = options.keyGenerator ?? webpush.generateVAPIDKeys
    this.vapidSubject = options.vapidSubject ?? 'https://solus.sh'
    this.keys = this.loadOrCreateKeys()
    this.loadSubscriptions()
  }

  getPublicKey(): string {
    return this.keys.publicKey
  }

  subscribe<T>(deviceId: string, deviceLabel: string, subscription: T): PushSubscriptionRecord {
    const cleanDeviceId = deviceId.trim()
    if (!cleanDeviceId || cleanDeviceId === 'electron') {
      throw new Error('Push subscriptions require a paired web device')
    }

    const record: PushSubscriptionRecord = {
      deviceId: cleanDeviceId,
      deviceLabel: deviceLabel.trim() || 'Web',
      subscription: normalizeSubscription(subscription),
      createdAt: Date.now(),
    }
    this.subscriptions.set(cleanDeviceId, record)
    this.persistSubscriptions()
    return record
  }

  unsubscribe(deviceId: string): boolean {
    const deleted = this.subscriptions.delete(deviceId)
    if (deleted) this.persistSubscriptions()
    return deleted
  }

  hasOfflineSubscription(isDeviceOnline: (deviceId: string) => boolean): boolean {
    for (const record of this.subscriptions.values()) {
      if (!isDeviceOnline(record.deviceId)) return true
    }
    return false
  }

  async sendToOfflineDevices(
    entry: AttentionEntry,
    isDeviceOnline: (deviceId: string) => boolean,
    installationId?: string,
  ): Promise<PushSendStats> {
    const payload = JSON.stringify(payloadForAttentionEntry(entry, { installationId }))
    const options: RequestOptions = {
      vapidDetails: {
        subject: this.vapidSubject,
        publicKey: this.keys.publicKey,
        privateKey: this.keys.privateKey,
      },
      TTL: 60 * 60,
    }

    const stats: PushSendStats = { attempted: 0, sent: 0, dropped: 0 }
    let droppedAny = false

    for (const record of this.subscriptions.values()) {
      if (isDeviceOnline(record.deviceId)) continue

      stats.attempted += 1
      try {
        await this.sender(record.subscription, payload, options)
        stats.sent += 1
      } catch (err) {
        const statusCode = statusCodeFromError(err)
        if (statusCode === 404 || statusCode === 410) {
          this.subscriptions.delete(record.deviceId)
          stats.dropped += 1
          droppedAny = true
          continue
        }
        log.warn('web_push_send_failed', { deviceId: record.deviceId, error: err instanceof Error ? err.message : String(err) })
      }
    }

    if (droppedAny) this.persistSubscriptions()
    return stats
  }

  listSubscriptions(): PushSubscriptionRecord[] {
    return [...this.subscriptions.values()]
  }

  private loadOrCreateKeys(): VapidKeys {
    if (existsSync(this.keysPath)) {
      try {
        const parsed = pushKeysFileSchema.safeParse(JSON.parse(readFileSync(this.keysPath, 'utf8')))
        if (parsed.success) return { publicKey: parsed.data.publicKey, privateKey: parsed.data.privateKey }
      } catch (err) {
        log.warn('push_vapid_keys_load_failed', { error: err instanceof Error ? err.message : String(err) })
      }
    }

    const keys = this.keyGenerator()
    writeJson0600(this.keysPath, { version: 1, ...keys } satisfies PushKeysFile)
    return keys
  }

  private loadSubscriptions(): void {
    if (!existsSync(this.subscriptionsPath)) return
    try {
      const parsed = pushSubscriptionsFileSchema.safeParse(JSON.parse(readFileSync(this.subscriptionsPath, 'utf8')))
      if (!parsed.success) return
      for (const record of Object.values(parsed.data.subscriptions)) {
        this.subscriptions.set(record.deviceId, {
          deviceId: record.deviceId,
          deviceLabel: record.deviceLabel || 'Web',
          subscription: normalizeSubscription(record.subscription),
          createdAt: record.createdAt,
        })
      }
    } catch (err) {
      log.warn('push_subscriptions_load_failed', { error: err instanceof Error ? err.message : String(err) })
    }
  }

  private persistSubscriptions(): void {
    writeJson0600(this.subscriptionsPath, {
      version: 1,
      subscriptions: Object.fromEntries(this.subscriptions),
    })
  }
}

function normalizeSubscription<T>(input: T): WebPushSubscriptionJSON {
  const parsed = webPushSubscriptionSchema.safeParse(input)
  if (!parsed.success) throw new Error('Invalid push subscription')
  return parsed.data
}

function writeJson0600<T>(path: string, value: T): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(value, null, 2), { mode: 0o600 })
  try { chmodSync(path, 0o600) } catch {}
}

function statusCodeFromError<T>(err: T): number | null {
  const parsed = z.object({ statusCode: z.number() }).safeParse(err)
  return parsed.success ? parsed.data.statusCode : null
}
