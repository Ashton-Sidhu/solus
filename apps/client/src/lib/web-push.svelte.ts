import { base64UrlToUint8Array } from '@solus/client-core/push'
import type { SolusAPI } from '@solus/contracts/host-api'
import type { WebPushSubscriptionJSON } from '@solus/contracts/types'
import { serverConnections } from '@solus/client-core/server-connections'
import { activeWorkspace, loadWorkspaces } from '@solus/client-core/workspace-registry'
import { solusApiId } from '@solus/contracts/uplink'
import {
  loadServers,
  onServerRemoving,
  onServerSaved,
} from '@solus/client-core/server-registry'
import {
  fanOutPushHosts,
  planPushReconciliation,
  PushReconciler,
  pushHostRefs,
  type PushHostRef,
} from './web-push-core'

/** Where this bundle is mounted; `/` on a host and on the account origin alike. */
const BASE = import.meta.env.BASE_URL

class WebPushState {
  supported = $state(false)

  private initialized = false
  private enabled: boolean | null = null
  private readonly reconciler = new PushReconciler(() => this.reconcileHosts())
  private readonly removedHosts = new Map<string, Promise<void>>()
  private shellRegistration: ServiceWorkerRegistration | null = null
  private registrations = new Map<string, ServiceWorkerRegistration>()

  init(): void {
    if (this.initialized) return
    this.initialized = true
    this.supported = isPushSupported()
    if (!this.supported) return
    void this.ensureShellRegistration().catch(() => {
      this.supported = false
    })
    // Settings asks for the grant; subscribe or drop the hosts once it changes.
    void navigator.permissions?.query({ name: 'notifications' })
      .then((status) => status.addEventListener('change', () => this.scheduleReconcile()))
      .catch(() => {})
    serverConnections.onStatusChange((_serverId, status) => {
      if (status === 'connected') this.scheduleReconcile()
    })
    onServerSaved((server) => {
      this.removedHosts.delete(server.id)
      this.scheduleReconcile()
    })
    onServerRemoving((server) => {
      // Start before the registry removes the host's credentials.
      this.removedHosts.set(server.id, this.unsubscribeFromServer(server.id))
      this.scheduleReconcile()
    })
  }

  async syncEnabled(enabled: boolean): Promise<void> {
    if (this.enabled === enabled) return
    this.enabled = enabled
    await this.reconcile()
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
      applicationServerKey: new Uint8Array(base64UrlToUint8Array(publicKey)),
    })
    const serialized = subscription.toJSON()
    if (!serialized.endpoint || !serialized.keys?.auth || !serialized.keys?.p256dh) {
      throw new Error('Push subscription is missing browser keys')
    }
    const json: WebPushSubscriptionJSON = {
      endpoint: serialized.endpoint,
      keys: { auth: serialized.keys.auth, p256dh: serialized.keys.p256dh },
    }
    if (serialized.expirationTime !== undefined) json.expirationTime = serialized.expirationTime
    await api.pushSubscribe(json)
  }

  private hosts(): PushHostRef[] {
    // The serving-origin host may be unsaved, so it is added beside the saved list.
    const bootServerId = serverConnections.defaultServerId()
    const boot = bootServerId ? serverConnections.connectionFor(bootServerId) : undefined
    let bootHost: PushHostRef | null = null
    if (boot) {
      bootHost = { serverId: boot.serverId }
      if (boot.target.installationId) bootHost.installationId = boot.target.installationId
    }
    // The window's organization's workspace service sends that organization's
    // notifications, so it is subscribed beside the machines. Another
    // organization's service is not dialed for this (organization-scope §7):
    // borrowing a socket to it would look like a connection change and start
    // the reconciliation again.
    const active = activeWorkspace(loadWorkspaces())
    const workspaces = active ? [{ serverId: solusApiId(active.organizationId) }] : []
    return pushHostRefs(loadServers(), bootHost, workspaces)
  }

  private scheduleReconcile(): void {
    void this.reconcile().catch((error) => {
      console.warn('[solus:web-push] reconciliation failed', error)
    })
  }

  private reconcile(): Promise<void> {
    if (!this.supported || (this.enabled === null && this.removedHosts.size === 0)) return Promise.resolve()
    return this.reconciler.request()
  }

  private async reconcileHosts(): Promise<void> {
    const hosts = this.hosts().filter((host) => !this.removedHosts.has(host.serverId))
    const registrations = await this.hostRegistrations()
    const knownServerIds = new Set([
      ...hosts.map((host) => host.serverId),
      ...registrations.keys(),
      ...this.removedHosts.keys(),
    ])
    const plan = planPushReconciliation(
      hosts,
      knownServerIds,
      this.enabled === true && Notification.permission === 'granted',
    )
    await Promise.all([
      fanOutPushHosts(plan.subscribe, (host) => this.subscribeHost(host)),
      Promise.allSettled(plan.unsubscribe.map((serverId) => this.unsubscribeHost(
        serverId,
        this.removedHosts.get(serverId),
      ))),
    ])
  }

  private async ensureShellRegistration(): Promise<ServiceWorkerRegistration> {
    if (!this.shellRegistration) {
      this.shellRegistration = await navigator.serviceWorker.register(`${BASE}sw.js?shell=1`, { scope: BASE })
    }
    return this.shellRegistration
  }

  private async registrationForHost(host: PushHostRef): Promise<ServiceWorkerRegistration> {
    const existing = this.registrations.get(host.serverId)
    if (existing) return existing
    const registration = await navigator.serviceWorker.register(
      `${BASE}sw.js?pushHost=${encodeURIComponent(host.serverId)}`,
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

}

function pushScope(serverId: string): string {
  return `${BASE}push/${encodeURIComponent(serverId)}/`
}

function serverIdFromPushScope(scope: string): string | null {
  const path = new URL(scope).pathname
  const prefix = `${BASE}push/`
  if (!path.startsWith(prefix)) return null
  const match = path.slice(prefix.length).match(/^([^/]+)\/$/)
  return match?.[1] ? decodeURIComponent(match[1]) : null
}

function keysEqual(left: ArrayBuffer | null, right: Uint8Array): boolean {
  if (!left) return false
  const bytes = new Uint8Array(left)
  return bytes.length === right.length && bytes.every((value, index) => value === right[index])
}

function isPushSupported(): boolean {
  return window.isSecureContext
    && 'Notification' in window
    && 'serviceWorker' in navigator
    && 'PushManager' in window
}

export const webPushState = new WebPushState()
