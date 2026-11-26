import type { PairApprovalDecision, PairApprovalRequest } from '@solus/contracts/add-machine'
import { subscribeAllHosts } from '@solus/client-core/host-events'
import { serverConnections } from '@solus/client-core/server-connections'
import { SvelteMap, SvelteSet } from 'svelte/reactivity'
import { toasts } from '../../lib/toasts'
import { hosts } from '../hosts/hosts.svelte'
import { serversStore } from './servers.store.svelte'

/**
 * The open approval requests of each host this client reaches as its owner
 * (docs/plans/add-machine-card.md, "The approval request"): a machine asks to
 * pair without a code, and an owner approves or denies it. One toast tells of
 * each new request; Settings › Sharing & access lists the open ones.
 */

/** One host's open requests as this client last read them. */
export interface HostApprovals {
  state: 'loading' | 'ready' | 'error'
  approvals: PairApprovalRequest[]
  error: string
}

/** The calls the store makes; the real ones go to each host. */
export interface PairApprovalsSource {
  list: (serverId: string) => Promise<PairApprovalRequest[]>
  decide: (serverId: string, requestId: string, decision: PairApprovalDecision) => Promise<boolean>
  /** `host.pairApprovalsChanged` from every host: the whole list. */
  follow: (onChange: (serverId: string, approvals: PairApprovalRequest[]) => void) => () => void
  /** A host became ready; its list is read again. */
  onHostReady: (listener: (serverId: string) => void) => () => void
  hostIds: () => string[]
  /** This client holds `host.local.reach` there, once the host said how it admitted this client. */
  mayReach: (serverId: string) => Promise<boolean>
  hostLabel: (serverId: string) => string
}

/** How the person hears of a request. */
export interface PairApprovalNotices {
  show: (serverId: string, approval: PairApprovalRequest, hostLabel: string) => void
  dismiss: (serverId: string, requestId: string) => void
  failed: (message: string) => void
}

/** The words of one notice: who asks, and the check code to compare. */
export interface ApprovalNoticeText {
  message: string
  description: string
}

/** The words of the notice. The check code is what the person compares on the other machine. */
export function approvalNoticeText(approval: PairApprovalRequest, hostLabel: string): ApprovalNoticeText {
  return {
    message: `${approval.deviceLabel} at ${approval.fromAddress} asks to pair with ${hostLabel}.`,
    description: `Approve only if it shows ${approval.checkCode}.`,
  }
}

export class PairApprovalsStore {
  readonly byHost = new SvelteMap<string, HostApprovals>()
  /** Request ids with a decision in flight. */
  readonly deciding = new SvelteSet<string>()
  /** Requests already told of, as `serverId:requestId`: a new list of the same requests tells of none again. */
  readonly #announced = new Set<string>()

  constructor(
    private readonly source: PairApprovalsSource,
    private readonly notices: PairApprovalNotices,
  ) {}

  forHost(serverId: string): HostApprovals | undefined {
    return this.byHost.get(serverId)
  }

  /** Reads each host's list now and when it connects again, and follows its changes. The result stops it. */
  start(): () => void {
    const stops = [
      // The host sends this topic only to principals with `host.local.reach`.
      this.source.follow((serverId, approvals) => this.#apply(serverId, approvals)),
      this.source.onHostReady((serverId) => void this.load(serverId)),
    ]
    for (const serverId of this.source.hostIds()) void this.load(serverId)
    return () => stops.forEach((stop) => stop())
  }

  async load(serverId: string): Promise<void> {
    if (!(await this.source.mayReach(serverId))) return
    if (!this.byHost.has(serverId)) this.byHost.set(serverId, { state: 'loading', approvals: [], error: '' })
    try {
      this.#apply(serverId, await this.source.list(serverId))
    } catch (error) {
      const held = this.byHost.get(serverId)
      this.byHost.set(serverId, { state: 'error', approvals: held?.approvals ?? [], error: error instanceof Error ? error.message : String(error) })
    }
  }

  async decide(serverId: string, requestId: string, decision: PairApprovalDecision): Promise<void> {
    if (this.deciding.has(requestId)) return
    this.deciding.add(requestId)
    this.notices.dismiss(serverId, requestId)
    try {
      const isDecided = await this.source.decide(serverId, requestId, decision)
      this.#drop(serverId, requestId)
      if (!isDecided) this.notices.failed('This request is no longer open.')
    } catch (error) {
      this.notices.failed(error instanceof Error ? error.message : String(error))
    } finally {
      this.deciding.delete(requestId)
    }
  }

  #apply(serverId: string, approvals: PairApprovalRequest[]): void {
    const open = new Set(approvals.map((approval) => approval.requestId))
    // A request that left the list (decided elsewhere, or expired) takes its toast with it.
    for (const held of this.byHost.get(serverId)?.approvals ?? []) {
      if (!open.has(held.requestId)) this.notices.dismiss(serverId, held.requestId)
    }
    this.byHost.set(serverId, { state: 'ready', approvals, error: '' })
    for (const approval of approvals) {
      const key = `${serverId}:${approval.requestId}`
      if (this.#announced.has(key)) continue
      this.#announced.add(key)
      this.notices.show(serverId, approval, this.source.hostLabel(serverId))
    }
  }

  #drop(serverId: string, requestId: string): void {
    const held = this.byHost.get(serverId)
    if (!held) return
    const index = held.approvals.findIndex((approval) => approval.requestId === requestId)
    if (index !== -1) held.approvals.splice(index, 1)
  }
}

const toastId = (serverId: string, requestId: string) => `pair-approval:${serverId}:${requestId}`

export const pairApprovalsStore: PairApprovalsStore = new PairApprovalsStore(
  {
    list: (serverId) => serverConnections.apiFor(serverId).hostsPairApprovals(),
    decide: (serverId, requestId, decision) => serverConnections.apiFor(serverId).hostsPairApprovalDecide(requestId, decision),
    follow: (onChange) => subscribeAllHosts('host.pairApprovalsChanged', (serverId, event) => onChange(serverId, event.approvals)),
    onHostReady: (listener) => serverConnections.onReadinessChange((serverId, readiness) => {
      if (readiness === 'ready') listener(serverId)
    }),
    hostIds: () => serverConnections.serverIds(),
    mayReach: async (serverId) => {
      const host = hosts.get(serverId)
      if (!host) return false
      // Until the host answers, a standing reads as the owner's; a guest must not be asked.
      await host.when('serverInfo').catch(() => {})
      return host.me.principal !== undefined && host.me.may('host.local.reach')
    },
    hostLabel: (serverId) => serversStore.hostFor(serverId)?.label || 'this host',
  },
  {
    // Sonner holds two actions: Approve and Deny. Settings › Sharing & access lists every open request.
    show: (serverId, approval, hostLabel) => {
      const text = approvalNoticeText(approval, hostLabel)
      toasts.show({
        id: toastId(serverId, approval.requestId),
        ...text,
        duration: Math.max(1000, approval.expiresAt - Date.now()),
        closeButton: true,
        actions: [
          { label: 'Approve', onAction: () => void pairApprovalsStore.decide(serverId, approval.requestId, 'approve') },
          { label: 'Deny', onAction: () => void pairApprovalsStore.decide(serverId, approval.requestId, 'deny') },
        ],
      })
    },
    dismiss: (serverId, requestId) => { toasts.dismiss(toastId(serverId, requestId)) },
    failed: (message) => { toasts.error('Could not answer the approval request', { description: message }) },
  },
)
