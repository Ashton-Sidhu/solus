import { SvelteMap } from 'svelte/reactivity'
import type {
  HostWebhookSettings,
  HostWebhookSettingsPatch,
  Webhook,
  WebhookChangedEvent,
  WebhookCreateInput,
  WebhookDelivery,
  WebhookDeliverySummary,
  WebhookDryRunRequest,
  WebhookDryRunResult,
  WebhookUpdateInput,
  WebhookUrl,
  WebhookWithUrl,
} from '@solus/contracts/webhooks'
import { isSolusApiId } from '@solus/contracts/uplink'
import { sameHostPath } from '@solus/contracts/host-path'
import { serverConnections } from '@solus/client-core/server-connections'
import { subscribeAllHosts } from '@solus/client-core/host-events'
import { serversStore } from '../connections/servers.store.svelte'
import { copyText } from '../../lib/toasts'
import { organizationsStore } from '../../components/connections/organizations.store.svelte'
import type { WebhookRow } from '../../components/webhooks/lib/webhooks-view'

/**
 * Every webhook this client can see, read from each connected host and joined
 * into one list (docs/plans/webhooks.md §4). Each row names its host. A host
 * that is not ready has no rows here: the list never shows old rows as current.
 * `webhook.changed` and `webhook.delivery` keep the rows fresh, and a reconnect
 * reads the host again.
 */

/** `unavailable`: the host answered with an error, for example an older host without webhooks. */
export type WebhookHostStatus = 'loading' | 'ready' | 'unavailable'

export interface WebhookHost {
  serverId: string
  label: string
  /** The host is ready, so its rows are current. */
  connected: boolean
  status: WebhookHostStatus | null
}

/** The newest deliveries of one webhook that the detail view reads. */
const DELIVERY_PAGE = 200

function webhookKey(serverId: string, webhookId: string): string {
  return `${serverId}\n${webhookId}`
}

/** A read, split: the URL holds the token, so it is kept apart from the row. */
interface WebhookRead {
  webhook: Webhook
  url: WebhookUrl | null
}

function withoutUrl(webhook: Webhook | WebhookWithUrl): WebhookRead {
  if (!('url' in webhook)) return { webhook, url: null }
  const { url, ...rest } = webhook
  return { webhook: rest, url }
}

class WebhooksStore {
  /** Keyed by host and webhook id: two hosts can hold the same id. */
  readonly entries = new SvelteMap<string, WebhookRow>()
  readonly hostStatus = new SvelteMap<string, WebhookHostStatus>()
  readonly hostSettings = new SvelteMap<string, HostWebhookSettings>()
  /** The URL of each webhook this person owns, from a read; never from the list. */
  readonly urls = new SvelteMap<string, WebhookUrl>()
  /** Whether this person owns the webhook, from the last read. */
  readonly owned = new SvelteMap<string, boolean>()
  /** Newest first, for each webhook whose deliveries a view loaded. */
  readonly deliveries = new SvelteMap<string, WebhookDeliverySummary[]>()
  private revision = 0
  private readonly revisions = new Map<string, number>()
  private readonly rowReads = new Map<string, Promise<void>>()
  private watchCount = 0
  private stopWatching: (() => void) | null = null

  /** Surfaces that show webhooks hold one shared watch over every host. */
  watch(): () => void {
    if (this.watchCount++ === 0) {
      const stopChanged = subscribeAllHosts('webhook.changed', (serverId, event) => this.applyChange(serverId, event))
      const stopDelivery = subscribeAllHosts('webhook.delivery', (serverId, delivery) => this.applyDelivery(serverId, delivery))
      const stopReadiness = serverConnections.onReadinessChange((serverId, status) => {
        if (isSolusApiId(serverId)) return
        if (status === 'ready') void this.load(serverId)
        else this.forgetHost(serverId)
      })
      this.stopWatching = () => { stopChanged(); stopDelivery(); stopReadiness() }
      for (const serverId of this.machineIds()) {
        if (serverConnections.readinessFor(serverId).readiness === 'ready') void this.load(serverId)
      }
    }
    return () => {
      if (--this.watchCount > 0) return
      this.stopWatching?.()
      this.stopWatching = null
    }
  }

  private machineIds(): string[] {
    return serverConnections.connectedServerIds().filter((serverId) => !isSolusApiId(serverId))
  }

  /** The machines this client holds, with whether their rows are current. */
  get hosts(): WebhookHost[] {
    void serversStore.servers
    return this.machineIds().map((serverId) => ({
      serverId,
      label: serversStore.hostFor(serverId)?.label ?? serverConnections.connectionFor(serverId)?.target.label ?? serverId,
      connected: serversStore.readinessFor(serverId).readiness === 'ready',
      status: this.hostStatus.get(serverId) ?? null,
    }))
  }

  /** Every row, sorted by name, then by host. */
  get rows(): WebhookRow[] {
    return [...this.entries.values()].sort((a, b) => a.webhook.name.localeCompare(b.webhook.name) || a.serverId.localeCompare(b.serverId))
  }

  rowsForProject(serverId: string, projectPath: string): WebhookRow[] {
    return this.rows.filter((row) => row.serverId === serverId && row.webhook.project !== null && sameHostPath(row.webhook.project, projectPath))
  }

  get(serverId: string, webhookId: string): WebhookRow | undefined {
    return this.entries.get(webhookKey(serverId, webhookId))
  }

  urlFor(serverId: string, webhookId: string): WebhookUrl | null {
    return this.urls.get(webhookKey(serverId, webhookId)) ?? null
  }

  isOwner(serverId: string, webhookId: string): boolean {
    return this.owned.get(webhookKey(serverId, webhookId)) === true
  }

  deliveriesFor(serverId: string, webhookId: string): WebhookDeliverySummary[] | undefined {
    return this.deliveries.get(webhookKey(serverId, webhookId))
  }

  /** The cloud-URL webhooks of one host: the senders that need a new URL after an unlink (plan §2.2). */
  cloudUrlCount(serverId: string): number {
    let count = 0
    for (const row of this.entries.values()) if (row.serverId === serverId && row.webhook.urlMode === 'cloud') count++
    return count
  }

  /** Read one host's list and its settings, and replace its rows. */
  async load(serverId: string): Promise<void> {
    const startedRevision = this.revision
    if (!this.hostStatus.has(serverId)) this.hostStatus.set(serverId, 'loading')
    try {
      const api = serverConnections.apiFor(serverId)
      const [list, settings] = await Promise.all([api.webhookList(), api.hostWebhookSettingsRead()])
      if (serverConnections.readinessFor(serverId).readiness !== 'ready') return
      this.hostSettings.set(serverId, settings)
      // The reachability text names a personal computer: its category is in the host's standing.
      if (settings.linked && !organizationsStore.statusFor(serverId)) void organizationsStore.refresh(serverId)
      const liveKeys = new Set<string>()
      for (const webhook of list) {
        const key = webhookKey(serverId, webhook.id)
        liveKeys.add(key)
        if ((this.revisions.get(key) ?? 0) > startedRevision) continue
        this.entries.set(key, { serverId, webhook })
      }
      for (const [key, row] of this.entries) {
        if (row.serverId !== serverId || liveKeys.has(key)) continue
        if ((this.revisions.get(key) ?? 0) > startedRevision) continue
        this.dropRow(key)
      }
      this.hostStatus.set(serverId, 'ready')
    } catch (error) {
      console.error('webhook list host load failed', serverId, error)
      this.hostStatus.set(serverId, 'unavailable')
    }
  }

  /** A host that went away: its rows are no longer current, so they go. */
  private forgetHost(serverId: string): void {
    this.hostStatus.delete(serverId)
    for (const [key, row] of this.entries) if (row.serverId === serverId) this.dropRow(key)
  }

  private dropRow(key: string): void {
    this.entries.delete(key)
    this.urls.delete(key)
    this.owned.delete(key)
    this.deliveries.delete(key)
  }

  private put(serverId: string, read: Webhook | WebhookWithUrl): Webhook {
    const key = webhookKey(serverId, read.id)
    const { webhook, url } = withoutUrl(read)
    this.revisions.set(key, ++this.revision)
    this.entries.set(key, { serverId, webhook })
    if (url) {
      this.urls.set(key, url)
      this.owned.set(key, true)
    }
    return webhook
  }

  applyChange(serverId: string, event: WebhookChangedEvent): void {
    if (event.kind === 'deleted') {
      const key = webhookKey(serverId, event.webhookId)
      this.revisions.set(key, ++this.revision)
      this.dropRow(key)
      return
    }
    this.put(serverId, event.webhook)
    // A host change (a link, a public URL) gives a new URL: read it again for its owner.
    const key = webhookKey(serverId, event.webhook.id)
    const url = this.urls.get(key)
    if (url && url.mode !== event.webhook.urlMode) void this.read(serverId, event.webhook.id)
  }

  /** A delivery changes the row's last delivery and count: read the row again, once at a time. */
  applyDelivery(serverId: string, delivery: WebhookDeliverySummary): void {
    const key = webhookKey(serverId, delivery.webhookId)
    const list = this.deliveries.get(key)
    // A SvelteMap value is not deeply reactive, so the list is set again. It holds at most one page.
    if (list) {
      const index = list.findIndex((existing) => existing.id === delivery.id)
      this.deliveries.set(key, index === -1 ? [delivery, ...list] : list.with(index, delivery))
    }
    if (!this.entries.has(key) || this.rowReads.has(key)) return
    const read = this.read(serverId, delivery.webhookId).finally(() => this.rowReads.delete(key))
    this.rowReads.set(key, read)
  }

  async read(serverId: string, webhookId: string): Promise<void> {
    const key = webhookKey(serverId, webhookId)
    const read = await serverConnections.apiFor(serverId).webhookRead(webhookId)
    if (!read) {
      this.revisions.set(key, ++this.revision)
      this.dropRow(key)
      return
    }
    this.put(serverId, read)
    this.owned.set(key, 'url' in read)
    if (!('url' in read)) this.urls.delete(key)
  }

  async create(serverId: string, input: WebhookCreateInput): Promise<Webhook> {
    return this.put(serverId, await serverConnections.apiFor(serverId).webhookCreate(input))
  }

  async update(serverId: string, webhookId: string, patch: WebhookUpdateInput): Promise<void> {
    const updated = await serverConnections.apiFor(serverId).webhookUpdate(webhookId, patch)
    if (updated) this.put(serverId, updated)
  }

  /** Copy the URL, then tell the host, so the editor stops marking it as changed. */
  async copyUrl(serverId: string, webhookId: string): Promise<void> {
    const url = this.urlFor(serverId, webhookId)?.url
    if (!url) return
    await copyText(url)
    await this.update(serverId, webhookId, { copiedUrl: url })
  }

  async rotate(serverId: string, webhookId: string): Promise<void> {
    const rotated = await serverConnections.apiFor(serverId).webhookRotate(webhookId)
    if (rotated) this.put(serverId, rotated)
  }

  async remove(serverId: string, webhookId: string): Promise<void> {
    const key = webhookKey(serverId, webhookId)
    if (!(await serverConnections.apiFor(serverId).webhookDelete(webhookId))) return
    this.revisions.set(key, ++this.revision)
    this.dropRow(key)
  }

  async loadDeliveries(serverId: string, webhookId: string): Promise<void> {
    const list = await serverConnections.apiFor(serverId).webhookListDeliveries(webhookId, { limit: DELIVERY_PAGE })
    this.deliveries.set(webhookKey(serverId, webhookId), list)
  }

  /** One delivery with its request and action results. Read when the detail opens; not kept. */
  readDelivery(serverId: string, webhookId: string, deliveryId: string): Promise<WebhookDelivery | null> {
    return serverConnections.apiFor(serverId).webhookReadDelivery(webhookId, deliveryId)
  }

  async replay(serverId: string, webhookId: string, deliveryId: string, actionId?: string): Promise<void> {
    const summary = await serverConnections.apiFor(serverId).webhookReplay(webhookId, deliveryId, actionId)
    this.applyDelivery(serverId, summary)
  }

  /** Starts nothing and stores nothing (plan §3.3). */
  dryRun(serverId: string, request: WebhookDryRunRequest): Promise<WebhookDryRunResult> {
    return serverConnections.apiFor(serverId).webhookDryRun(request)
  }

  /** A new public URL or hold setting can change every URL of the host: read its list again. */
  async saveHostSettings(serverId: string, patch: HostWebhookSettingsPatch): Promise<void> {
    this.hostSettings.set(serverId, await serverConnections.apiFor(serverId).hostWebhookSettingsUpdate(patch))
    await this.load(serverId)
  }
}

export const webhooksStore = new WebhooksStore()
