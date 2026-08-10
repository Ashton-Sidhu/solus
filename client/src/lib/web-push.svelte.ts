import { base64UrlToUint8Array } from '@client-core/push'
import type { SolusAPI } from '../../../src/preload'
import type { WebPushSubscriptionJSON } from '@shared/types'
import { track } from '@renderer/lib/analytics'
import { serverConnections } from '@client-core/server-connections'
import {
  loadServers,
  onServerRemoving,
  onServerSaved,
} from '@client-core/server-registry'
import {
  fanOutPushHosts,
  planPushReconciliation,
  pushHostRefs,
  type PushHostRef,
} from './web-push-core'

class WebPushState {
  supported = $state(false)
  permission = $state<NotificationPermission>('default')
  subscribed = $state(false)
  busy = $state(false)

  private initialized = false
  private enabled: boolean | null = null
  private reconcileEpoch = 0
  private activeOperations = 0
  private shellRegistration: ServiceWorkerRegistration | null = null
  private registrations = new Map<string, ServiceWorkerRegistration>()

  init(): void {
    if (this.initialized) return
    this.initialized = true
    this.supported = isPushSupported()
    if (!this.supported) return
    this.permission = Notification.permission
    void this.ensureShellRegistration().catch(() => {
      this.supported = false
    })
    serverConnections.onStatusChange((_serverId, status) => {
      if (status === 'connected') void this.reconcile()
    })
    onServerSaved(() => void this.reconcile())
    onServerRemoving((server) => void this.reconcile(server.id))
  }

  async syncEnabled(enabled: boolean): Promise<void> {
    this.enabled = enabled
    await this.reconcile()
  }

  private async enableWithPermission(): Promise<void> {
    if (!this.supported || this.busy) return
    this.beginOperation()
    try {
      if (Notification.permission === 'default') {
        this.permission = await Notification.requestPermission()
      } else {
        this.permission = Notification.permission
      }
      track('push_permission_result', { granted: this.permission === 'granted' })
      if (this.permission === 'granted') {
        this.enabled = true
        await this.reconcile()
      }
    } finally {
      this.endOperation()
    }
  }

  private async unsubscribeHost(serverId: string, serverUnsubscribe = this.unsubscribeFromServer(serverId)): Promise<void> {
    const registration = this.registrations.get(serverId)
      ?? await this.findHostRegistration(serverId)
    const subscription = await registration?.pushManager.getSubscription()
    if (subscription) await subscription.unsubscribe().catch(() => false)
    if (registration) await registration.unregister().catch(() => false)
    this.registrations.delete(serverId)
    await serverUnsubscribe
  }

  private async unsubscribeFromServer(serverId: string): Promise<void> {
    const connection = serverConnections.connectionFor(serverId)
    if (connection?.status === 'connected') {
      await connection.api.pushUnsubscribe().catch(() => ({ ok: false }))
      return
    }
    const reachable = await serverConnections.probeHealth(serverId, true).catch(() => null)
    if (!reachable) return
    await serverConnections.withTemporaryConnection(serverId, (api) => api.pushUnsubscribe()).catch(() => {})
  }

  async toggle(): Promise<void> {
    if (this.subscribed) {
      this.enabled = false
      await this.reconcile()
    } else {
      await this.enableWithPermission()
    }
  }

  private async subscribeHost(host: PushHostRef): Promise<void> {
    const connection = serverConnections.connectionFor(host.serverId)
    if (connection?.status === 'connected') {
      await this.registerWithHost(host, connection.api)
      return
    }
    const reachable = await serverConnections.probeHealth(host.serverId, true).catch(() => null)
    if (!reachable) throw new Error('Host is offline')
    await serverConnections.withTemporaryConnection(host.serverId, (api) => this.registerWithHost(host, api))
  }

  private async registerWithHost(host: PushHostRef, api: Pick<SolusAPI, 'pushGetPublicKey' | 'pushSubscribe'>): Promise<void> {
    const publicKey = await api.pushGetPublicKey()
    const registration = await this.registrationForHost(host)
    let subscription = await registration.pushManager.getSubscription()
    if (subscription && !keysEqual(subscription.options.applicationServerKey, base64UrlToUint8Array(publicKey))) {
      await subscription.unsubscribe()
      subscription = null
    }
    subscription ??= await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: base64UrlToUint8Array(publicKey),
    })
    const json = subscription.toJSON() as WebPushSubscriptionJSON
    if (!json.endpoint || !json.keys?.auth || !json.keys?.p256dh) {
      throw new Error('Push subscription is missing browser keys')
    }
    await api.pushSubscribe(json)
  }

  private hosts(): PushHostRef[] {
    const primary = serverConnections.connectionFor()
    return pushHostRefs(loadServers(), primary ? {
      serverId: primary.serverId,
      ...(primary.target.installationId ? { installationId: primary.target.installationId } : {}),
    } : null)
  }

  private async reconcile(removingServerId?: string): Promise<void> {
    if (!this.supported || (this.enabled === null && !removingServerId)) return
    const removalUnsubscribe = removingServerId
      ? this.unsubscribeFromServer(removingServerId)
      : null
    const epoch = ++this.reconcileEpoch
    this.beginOperation()
    try {
      const hosts = this.hosts()
      const registrations = await this.hostRegistrations()
      const knownServerIds = new Set([
        ...hosts.map((host) => host.serverId),
        ...registrations.keys(),
      ])
      const plan = planPushReconciliation(
        hosts,
        knownServerIds,
        this.enabled === true && Notification.permission === 'granted',
        removingServerId,
      )
      await Promise.all([
        fanOutPushHosts(plan.subscribe, (host) => this.subscribeHost(host)),
        Promise.allSettled(plan.unsubscribe.map((serverId) => this.unsubscribeHost(
          serverId,
          serverId === removingServerId && removalUnsubscribe
            ? removalUnsubscribe
            : undefined,
        ))),
      ])
      if (epoch !== this.reconcileEpoch) return
      this.permission = Notification.permission
      this.subscribed = (await Promise.all(plan.subscribe.map(async (host) => {
        const registration = await this.findHostRegistration(host.serverId)
        return !!(await registration?.pushManager.getSubscription())
      }))).some(Boolean)
    } finally {
      this.endOperation()
    }
  }

  private async ensureShellRegistration(): Promise<ServiceWorkerRegistration> {
    if (!this.shellRegistration) {
      this.shellRegistration = await navigator.serviceWorker.register('/sw.js?shell=1', { scope: '/' })
    }
    return this.shellRegistration
  }

  private async registrationForHost(host: PushHostRef): Promise<ServiceWorkerRegistration> {
    const existing = this.registrations.get(host.serverId)
    if (existing) return existing
    const registration = await navigator.serviceWorker.register(
      `/sw.js?pushHost=${encodeURIComponent(host.serverId)}`,
      { scope: pushScope(host.serverId) },
    )
    this.registrations.set(host.serverId, registration)
    return registration
  }

  private async findHostRegistration(serverId: string): Promise<ServiceWorkerRegistration | null> {
    const cached = this.registrations.get(serverId)
    if (cached) return cached
    return (await this.hostRegistrations()).get(serverId) ?? null
  }

  private async hostRegistrations(): Promise<Map<string, ServiceWorkerRegistration>> {
    const registrations = new Map<string, ServiceWorkerRegistration>()
    for (const registration of await navigator.serviceWorker.getRegistrations()) {
      const serverId = serverIdFromPushScope(registration.scope)
      if (serverId) registrations.set(serverId, registration)
    }
    this.registrations = registrations
    return registrations
  }

  private beginOperation(): void {
    this.activeOperations += 1
    this.busy = true
  }

  private endOperation(): void {
    this.activeOperations -= 1
    this.busy = this.activeOperations > 0
  }
}

function pushScope(serverId: string): string {
  return `/push/${encodeURIComponent(serverId)}/`
}

function serverIdFromPushScope(scope: string): string | null {
  const match = new URL(scope).pathname.match(/^\/push\/([^/]+)\/$/)
  return match?.[1] ? decodeURIComponent(match[1]) : null
}

function keysEqual(left: ArrayBuffer | null, right: Uint8Array): boolean {
  if (!left) return false
  const bytes = new Uint8Array(left)
  return bytes.length === right.length && bytes.every((value, index) => value === right[index])
}

function isPushSupported(): boolean {
  return typeof window !== 'undefined'
    && window.isSecureContext
    && 'Notification' in window
    && 'serviceWorker' in navigator
    && 'PushManager' in window
}

export const webPushState = new WebPushState()
