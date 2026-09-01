import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'
import * as webpush from 'web-push'
import { dataDir } from '../platform/paths'
import { createLogger } from '../logger'
import type { PushSubscription, RequestOptions, SendResult, VapidKeys } from 'web-push'
import type { AttentionEntry, AttentionKind } from '../../shared/attention-types'
import type { WebPushSubscriptionJSON } from '../../shared/types'

const log = createLogger('notifications', 'push-service.ts')

const PUSHABLE_KINDS = new Set<AttentionKind>(['needs_approval', 'question', 'failed'])

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

interface PushSubscriptionsFile {
  version: 1
  subscriptions: Record<string, PushSubscriptionRecord>
}

export interface PushNotificationPayload {
  title: string
  body: string
  sessionId: string
  kind: AttentionKind
}

export interface PushSendStats {
  attempted: number
  sent: number
  dropped: number
}

export type PushSender = (
  subscription: PushSubscription,
  payload: string,
  options: RequestOptions,
) => Promise<SendResult | unknown>

export interface PushNotificationServiceOptions {
  keysPath?: string
  subscriptionsPath?: string
  sender?: PushSender
  keyGenerator?: () => VapidKeys
  vapidSubject?: string
}

export function attentionEntryKey(entry: Pick<AttentionEntry, 'sessionId' | 'kind'>): string {
  return `${entry.sessionId}:${entry.kind}`
}

export function diffNewPushAttentionEntries(
  previousKeys: ReadonlySet<string>,
  entries: AttentionEntry[],
): { created: AttentionEntry[]; nextKeys: Set<string> } {
  const nextKeys = new Set<string>()
  const created: AttentionEntry[] = []

  for (const entry of entries) {
    const key = attentionEntryKey(entry)
    nextKeys.add(key)

    // Finished entries are useful in the attention inbox but too noisy for push.
    if (!PUSHABLE_KINDS.has(entry.kind)) continue
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

  subscribe(deviceId: string, deviceLabel: string, subscription: unknown): PushSubscriptionRecord {
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
  ): Promise<PushSendStats> {
    const payload = JSON.stringify(payloadForAttentionEntry(entry))
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
        log.warn(`web push send failed for device ${record.deviceId}: ${String(err)}`)
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
        const parsed = JSON.parse(readFileSync(this.keysPath, 'utf8')) as PushKeysFile
        if (typeof parsed.publicKey === 'string' && typeof parsed.privateKey === 'string') {
          return { publicKey: parsed.publicKey, privateKey: parsed.privateKey }
        }
      } catch (err) {
        log.warn(`failed to load push VAPID keys, regenerating: ${String(err)}`)
      }
    }

    const keys = this.keyGenerator()
    writeJson0600(this.keysPath, { version: 1, ...keys } satisfies PushKeysFile)
    return keys
  }

  private loadSubscriptions(): void {
    if (!existsSync(this.subscriptionsPath)) return
    try {
      const parsed = JSON.parse(readFileSync(this.subscriptionsPath, 'utf8')) as PushSubscriptionsFile
      for (const record of Object.values(parsed.subscriptions ?? {})) {
        if (!record?.deviceId) continue
        this.subscriptions.set(record.deviceId, {
          deviceId: record.deviceId,
          deviceLabel: record.deviceLabel || 'Web',
          subscription: normalizeSubscription(record.subscription),
          createdAt: typeof record.createdAt === 'number' ? record.createdAt : Date.now(),
        })
      }
    } catch (err) {
      log.warn(`failed to load push subscriptions: ${String(err)}`)
    }
  }

  private persistSubscriptions(): void {
    writeJson0600(this.subscriptionsPath, {
      version: 1,
      subscriptions: Object.fromEntries(this.subscriptions),
    } satisfies PushSubscriptionsFile)
  }
}

export function payloadForAttentionEntry(entry: AttentionEntry): PushNotificationPayload {
  return {
    title: titleForKind(entry.kind),
    body: entry.summary || 'A Solus session needs attention.',
    sessionId: entry.sessionId,
    kind: entry.kind,
  }
}

function titleForKind(kind: AttentionKind): string {
  switch (kind) {
    case 'needs_approval': return 'Solus - needs approval'
    case 'question': return 'Solus - has a question'
    case 'failed': return 'Solus - session failed'
    case 'finished': return 'Solus - finished'
  }
}

function normalizeSubscription(input: unknown): WebPushSubscriptionJSON {
  const candidate = input as Partial<WebPushSubscriptionJSON> | null
  if (
    !candidate ||
    typeof candidate.endpoint !== 'string' ||
    !candidate.keys ||
    typeof candidate.keys.p256dh !== 'string' ||
    typeof candidate.keys.auth !== 'string'
  ) {
    throw new Error('Invalid push subscription')
  }

  return {
    endpoint: candidate.endpoint,
    ...(typeof candidate.expirationTime === 'number' || candidate.expirationTime === null
      ? { expirationTime: candidate.expirationTime }
      : {}),
    keys: {
      p256dh: candidate.keys.p256dh,
      auth: candidate.keys.auth,
    },
  }
}

function writeJson0600(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(value, null, 2), { mode: 0o600 })
  try { chmodSync(path, 0o600) } catch {}
}

function statusCodeFromError(err: unknown): number | null {
  const statusCode = (err as { statusCode?: unknown } | null)?.statusCode
  return typeof statusCode === 'number' ? statusCode : null
}
