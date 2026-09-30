import { SvelteMap, SvelteSet } from 'svelte/reactivity'
import { serverConnections } from '@solus/client-core/server-connections'
import type { AgentProfileStatus } from '@solus/contracts/agent-profile'
import type { HostIdentity } from '../sharing/shares.store.svelte'

/**
 * Whether the caller has a profile on a host: a member has their seats there,
 * and an owner has the host's own homes — unless the host is this client's own
 * machine, which is where the profile comes from.
 */
export function profileAppliesTo(principal: HostIdentity['principal'] | null, serverId: string, localServerId: string | null): boolean {
  if (principal === 'org-member') return true
  return (principal === 'local-owner' || principal === 'remote-owner') && serverId !== localServerId
}

/**
 * A person's agent profile per host (docs/agent-profile.md). This client copies
 * the profile of its own machine — the desktop's local host — into the
 * person's seats on a shared host, or into the homes of a host they own such
 * as a personal VM: once per host each time the app runs, and again on
 * request. A client with no machine of its own (web, phone) shows the copy
 * there and can remove it.
 */
export class AgentProfileStore {
  /** serverId → whether the caller has a profile on that host (`profileAppliesTo`). */
  readonly applies = new SvelteMap<string, boolean>()
  /** serverId → the caller's profile on that host, as it last answered. */
  readonly statuses = new SvelteMap<string, AgentProfileStatus>()
  /** serverId → why the last copy or removal failed. */
  readonly errors = new SvelteMap<string, string>()
  /** Hosts a copy or removal is in flight for, so a row cannot be double-submitted. */
  readonly busy = new SvelteSet<string>()
  private readonly copiedThisRun = new Set<string>()

  /** Whether this client runs on a machine whose profile it can copy. */
  get canCopy(): boolean {
    return !!serverConnections.localServerId()
  }

  async load(serverId: string): Promise<void> {
    try {
      this.statuses.set(serverId, await serverConnections.apiFor(serverId).agentProfileStatus())
    } catch {
      // An older host, or a connection that dropped: the row keeps its last answer.
    }
  }

  /** Learn who this client is on a host; the first time this run, the profile follows the person there. */
  noteHost(serverId: string, principal: HostIdentity['principal'] | null): void {
    const applies = profileAppliesTo(principal, serverId, serverConnections.localServerId())
    this.applies.set(serverId, applies)
    if (applies) this.copyOnce(serverId)
  }

  private copyOnce(serverId: string): void {
    if (!this.canCopy || this.copiedThisRun.has(serverId)) return
    this.copiedThisRun.add(serverId)
    void this.copy(serverId)
  }

  async copy(serverId: string): Promise<void> {
    const localServerId = serverConnections.localServerId()
    if (!localServerId || localServerId === serverId) return
    await this.run(serverId, async () => {
      const bundle = await serverConnections.apiFor(localServerId).agentProfileRead()
      this.statuses.set(serverId, await serverConnections.apiFor(serverId).agentProfileApply(bundle))
    })
  }

  /** The way out: an empty profile removes what was copied, and nothing else. */
  async remove(serverId: string): Promise<void> {
    await this.run(serverId, async () => {
      this.statuses.set(serverId, await serverConnections.apiFor(serverId).agentProfileApply({ files: [], skipped: [] }))
    })
  }

  private async run(serverId: string, task: () => Promise<void>): Promise<void> {
    if (this.busy.has(serverId)) return
    this.busy.add(serverId)
    this.errors.delete(serverId)
    try {
      await task()
    } catch (error) {
      this.errors.set(serverId, error instanceof Error ? error.message : String(error))
    } finally {
      this.busy.delete(serverId)
    }
  }
}

export const agentProfileStore = new AgentProfileStore()
