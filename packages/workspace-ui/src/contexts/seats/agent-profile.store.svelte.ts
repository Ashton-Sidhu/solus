import { SvelteMap, SvelteSet } from 'svelte/reactivity'
import { serverConnections } from '@solus/client-core/server-connections'
import type { AgentProfile, AgentProfileCopy, AgentProfileSkip, AgentProfileStatus } from '@solus/contracts/agent-profile'
import type { HostIdentity } from '../sharing/shares.store.svelte'
import type { AgentProfileLocalStore } from './agent-profile-local.store.svelte'
import { mergeComputerProfile } from './lib/agent-profile-local'

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
 * A person's agent profile per host (docs/agent-profile.md,
 * plans/020-agent-profile.md). Not signed in, this client pushes the profile of
 * its own machine — the desktop's local host — into the person's seats on a
 * shared host, or into the homes of a host they own: once per host each time
 * the app runs, and again on request. Signed in with profile sync on, a host
 * pulls the profile from the account instead, and this client asks it to after
 * its own write. A client with no machine of its own (web, phone) shows the
 * copy there, can ask for a pull, and can remove it.
 *
 * On the desktop, this computer's own skills, files, and MCP servers join this
 * client's copy of the profile (`importComputer`): when the copy is empty, by
 * itself; later, when the person asks. A push sends that copy, so what the
 * person removed or turned off on the Agent profile page holds on every host.
 */
export class AgentProfileStore {
  /** serverId → whether the caller has a profile on that host (`profileAppliesTo`). */
  readonly applies = new SvelteMap<string, boolean>()
  /** serverId → the caller's profile on that host, as it last answered. */
  readonly statuses = new SvelteMap<string, AgentProfileStatus>()
  /** serverId → why the last copy, pull, or removal failed. */
  readonly errors = new SvelteMap<string, string>()
  /** Hosts a copy or removal is in flight for, so a row cannot be double-submitted. */
  readonly busy = new SvelteSet<string>()
  /** A read of this computer's profile is in flight. */
  importing = $state(false)
  /** Why the last read of this computer's profile failed; null when it did not. */
  importError = $state<string | null>(null)
  /** This client's copy of the profile, which a computer's read fills and a push sends. Attached by the app core. */
  private local: AgentProfileLocalStore | null = null
  /** What the last read of this computer left out, carried with a push so the host's status says so. */
  private computerSkipped: AgentProfileSkip[] = []
  private readonly copiedThisRun = new Set<string>()
  /** Whether the person's profile lives in their account now: then a host pulls, and this client does not push. */
  private syncOn = false

  /** Whether this client runs on a machine whose profile it can copy. */
  get canCopy(): boolean {
    return !!serverConnections.localServerId()
  }

  /** The copy this client edits: what `importComputer` fills and `copy` pushes. */
  attachLocalCopy(local: AgentProfileLocalStore): void {
    this.local = local
  }

  /** Told by the profile sync engine: on, a host pulls; off, this client pushes as before. */
  setSync(on: boolean): void {
    this.syncOn = on
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
    if (this.copiedThisRun.has(serverId)) return
    if (this.syncOn) {
      this.copiedThisRun.add(serverId)
      void this.pull(serverId)
      return
    }
    if (!this.canCopy) return
    this.copiedThisRun.add(serverId)
    void this.copy(serverId)
  }

  /**
   * Push to a host: this client's copy, which is what the Agent profile page
   * shows, so an entry the person removed or turned off there stays off the
   * host. An empty copy fills from this computer first. Without a copy
   * attached, the computer's profile goes as it is.
   */
  async copy(serverId: string): Promise<void> {
    const localServerId = serverConnections.localServerId()
    if (!localServerId || localServerId === serverId) return
    await this.run(serverId, async () => {
      const copy = this.local ? await this.localCopy() : await serverConnections.apiFor(localServerId).agentProfileRead()
      this.statuses.set(serverId, await serverConnections.apiFor(serverId).agentProfileApply(copy))
    })
  }

  /** This client's copy as a push sends it; an empty copy fills from this computer first. */
  private async localCopy(): Promise<AgentProfileCopy> {
    if (!this.local) throw new Error('No copy of the profile on this client.')
    if (this.local.entryCount === 0) {
      await this.importComputer()
      if (this.importError) throw new Error(this.importError)
    }
    return { profile: this.local.storedEntries, skipped: this.computerSkipped }
  }

  /**
   * This computer's skills, files, and MCP servers join this client's copy of
   * the profile. Nothing leaves the copy. Nothing on a client with no machine
   * of its own, and nothing while a read is in flight.
   */
  async importComputer(): Promise<void> {
    const localServerId = serverConnections.localServerId()
    if (!localServerId || !this.local || this.importing) return
    this.importing = true
    this.importError = null
    try {
      const computer = await serverConnections.apiFor(localServerId).agentProfileRead()
      this.computerSkipped = computer.skipped
      this.local.replaceAll(mergeComputerProfile(this.local.storedEntries, computer.profile))
    } catch (error) {
      this.importError = error instanceof Error ? error.message : String(error)
    } finally {
      this.importing = false
    }
  }

  /** The first look: an empty copy on a client with a computer fills from it, so the page never starts blank. */
  importComputerIfEmpty(): void {
    if (this.local && this.local.entryCount === 0) void this.importComputer()
  }

  /** This machine's profile as it is now, for a first synced copy. Null on a client with no machine of its own. */
  async readComputer(): Promise<AgentProfile | null> {
    const localServerId = serverConnections.localServerId()
    if (!localServerId) return null
    return (await serverConnections.apiFor(localServerId).agentProfileRead()).profile
  }

  /** Ask a host to read the profile from the account: after this client's own write, and once per run when sync is on. */
  async pull(serverId: string): Promise<void> {
    await this.run(serverId, async () => {
      this.statuses.set(serverId, await serverConnections.apiFor(serverId).agentProfilePull())
    })
  }

  /** Every host the profile applies to pulls; a host that cannot keeps its last answer and its error. */
  pullEverywhere(): void {
    for (const [serverId, applies] of this.applies) if (applies) void this.pull(serverId)
  }

  /** The way out: an empty profile removes what was copied, and nothing else. */
  async remove(serverId: string): Promise<void> {
    await this.run(serverId, async () => {
      this.statuses.set(serverId, await serverConnections.apiFor(serverId).agentProfileApply({ profile: {}, skipped: [] }))
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
