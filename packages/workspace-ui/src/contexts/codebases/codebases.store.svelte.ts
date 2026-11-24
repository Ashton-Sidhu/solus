import { SvelteMap } from 'svelte/reactivity'
import type {
  Codebase,
  CodebaseFolderScan,
  CodebaseFolderSuggestion,
  CodebaseMember,
  CodebaseRoot,
} from '@solus/contracts/codebases'
import { hasEnoughRoots } from '@solus/contracts/codebases'
import { hostPathKey } from '@solus/contracts/host-path'
import {
  CodebaseRootRefused,
  codebasesHolding,
  hostRootsKey,
  isContainerRoot,
  isLiveCodebase,
  isSameRoot,
  liveCodebases,
  mergeCodebases,
  NEW_CODEBASE_NEEDS_FOLDERS,
  nextUpdatedAt,
  rootFor,
  rootInstallationIds,
  rootRefusal,
  rootRemovalRefusal,
} from '@solus/client-core/codebases'
import { liveCodebaseHostAccess, type CodebaseHostAccess, type CodebaseMachine } from './codebase-host-access'
import { provideContainerRule } from './container-rule'

/**
 * The codebases of this client (docs/plans/codebases.md decision 6 and §9).
 * Each host keeps the full record of each codebase. This store reads the
 * copies of each connected host, shows the newest copy of each codebase, and
 * sends that copy to each host that has an older one or none. A change by the
 * person goes to each connected host; a host that is away gets it when it is
 * ready again. The members of a codebase are not in the record: each host
 * reads them from its disk when a view asks.
 */

/** `unavailable`: the host answered with an error, for example an older host without codebases. */
export type CodebaseHostStatus = 'loading' | 'ready' | 'unavailable'

export interface CodebaseHost extends CodebaseMachine {
  /** The read of the host's codebases. Null while the host is away. */
  status: CodebaseHostStatus | null
}

/** A folder on a host of this client, before it is a root. */
export interface CodebaseRootChoice {
  serverId: string
  path: string
}

export interface CodebaseRootMembers {
  root: CodebaseRoot
  /** The folder of the root itself. Null until its host answers. */
  member: CodebaseMember | null
  /** The repositories found inside the root. */
  found: CodebaseMember[]
  /** Folders that a `.code-workspace` file in the root lists and that are not roots. Never added by themselves. */
  suggestions: CodebaseFolderSuggestion[]
}

/** `unknown`: no host of this client has the installation id that the roots name. */
export type CodebaseHostPresence = 'ready' | 'away' | 'unknown'

/** The roots of one codebase on one host, with what that host read from its disk. */
export interface CodebaseHostMembers {
  installationId: string
  /** This client's id for the host. Null when this client does not know the host. */
  serverId: string | null
  label: string | null
  presence: CodebaseHostPresence
  /** `idle`: the host was not asked. */
  state: 'idle' | 'loading' | 'ready' | 'error'
  /** The members are the last answer of the host, not a current one. */
  isStale: boolean
  error: string | null
  roots: CodebaseRootMembers[]
}

interface MemberRead {
  members: CodebaseMember[]
  /** By the path key of a root. */
  suggestions: Map<string, CodebaseFolderSuggestion[]>
  state: 'loading' | 'ready' | 'error'
  isStale: boolean
  hasAnswer: boolean
  error: string | null
  /** The roots on the host when it was asked (`hostRootsKey`). */
  rootsKey: string
}

interface PendingSend {
  promise: Promise<void>
  isSettled: boolean
}

/** The key of this client's own copies in the merge. No host has this id. */
const CLIENT_COPIES = '\u0000client'

const NOT_READ: MemberRead = { members: [], suggestions: new Map(), state: 'loading', isStale: false, hasAnswer: false, error: null, rootsKey: '' }

function memberReadKey(codebaseId: string, serverId: string): string {
  return `${codebaseId}\n${serverId}`
}

function requiredName(name: string): string {
  const trimmed = name.trim()
  if (!trimmed) throw new Error('A codebase needs a name.')
  return trimmed
}

export class CodebasesStore {
  /** The newest copy that this client knows of each codebase, by id. A deleted codebase is here as its tombstone. */
  private readonly newest = new SvelteMap<string, Codebase>()
  private readonly hostStatus = new SvelteMap<string, CodebaseHostStatus>()
  private readonly memberReads = new SvelteMap<string, MemberRead>()
  /** The last answer of each host, deleted copies included. Kept while a host is away. */
  private readonly copiesByHost = new Map<string, Codebase[]>()
  private readonly listReads = new Map<string, Promise<Codebase[]>>()
  /** One send for each host and copy, until the host is read again: a host that refuses a copy is not asked in a loop. */
  private readonly sends = new Map<string, PendingSend>()
  /** The newest read of each host's members. A token is never used again, so an old answer cannot look current. */
  private readonly memberReadTokens = new Map<string, number>()
  private memberReadCount = 0
  private readonly membersWatched = new Map<string, number>()
  private watchCount = 0
  private stopWatching: (() => void) | null = null

  constructor(
    private readonly access: CodebaseHostAccess = liveCodebaseHostAccess,
    private readonly now: () => number = Date.now,
  ) {}

  /** Surfaces that show codebases hold one shared watch over every host. */
  watch(): () => void {
    if (this.watchCount++ === 0) {
      const stopChanged = this.access.onCodebasesChanged((serverId) => {
        if (this.hostStatus.has(serverId)) void this.load(serverId)
      })
      const stopReadiness = this.access.onReadinessChange((serverId, isReady) => {
        if (isReady) void this.load(serverId)
        else this.forgetHost(serverId)
      })
      this.stopWatching = () => { stopChanged(); stopReadiness() }
      for (const machine of this.access.machines()) {
        if (machine.isReady) void this.load(machine.serverId)
      }
    }
    return () => {
      if (--this.watchCount > 0) return
      this.stopWatching?.()
      this.stopWatching = null
    }
  }

  /** The machines of this client, with the state of the read of their codebases. */
  get hosts(): CodebaseHost[] {
    return this.access.machines().map((machine) => ({ ...machine, status: this.hostStatus.get(machine.serverId) ?? null }))
  }

  /** The host of this client that a root names; null when this client does not know it. */
  hostOf(installationId: string): CodebaseHost | null {
    const hosts = this.hosts
    const resolvedId = this.access.resolveId(installationId)
    return hosts.find((host) => host.installationId === installationId)
      ?? hosts.find((host) => host.serverId === resolvedId)
      ?? null
  }

  /** The codebases that are not deleted, by name. */
  get codebases(): Codebase[] {
    return liveCodebases(this.newest.values())
  }

  /** One codebase that is not deleted. */
  codebaseOf(codebaseId: string): Codebase | undefined {
    const codebase = this.newest.get(codebaseId)
    return codebase && isLiveCodebase(codebase) ? codebase : undefined
  }

  /** True when a host of this client said that the codebase is deleted. False for a codebase that no host named. */
  isDeleted(codebaseId: string): boolean {
    const codebase = this.newest.get(codebaseId)
    return !!codebase && codebase.deletedAt !== null
  }

  /** The codebases that hold a folder on a host of this client: the folder is a root, or it is inside a root. */
  codebasesOfFolder(serverId: string, path: string): Codebase[] {
    const installationId = this.installationIdOf(serverId)
    return installationId ? codebasesHolding(this.codebases, installationId, path) : []
  }

  /**
   * True when a folder on a host of this client is the container root of a
   * codebase: it shows under Codebases, never in a project list (decision 14).
   */
  isContainerRoot(serverId: string, path: string): boolean {
    const installationId = this.installationIdOf(serverId)
    return !!installationId && isContainerRoot(this.codebases, installationId, path)
  }

  /**
   * The roots of one codebase, grouped by host, with the members that each
   * host read. A host that is away keeps its last answer with `isStale`. A
   * root on a host that this client does not know stays in the list with
   * `presence: 'unknown'`.
   */
  membersOf(codebaseId: string): CodebaseHostMembers[] {
    const codebase = this.codebaseOf(codebaseId)
    if (!codebase) return []
    return rootInstallationIds(codebase).map((installationId) => {
      const host = this.hostOf(installationId)
      const read = host ? this.memberReads.get(memberReadKey(codebaseId, host.serverId)) : undefined
      const roots = codebase.roots.filter((root) => root.installationId === installationId)
      const rootKeys = new Set(roots.map((root) => hostPathKey(root.path)))
      return {
        installationId,
        serverId: host?.serverId ?? null,
        label: host?.label ?? null,
        presence: !host ? 'unknown' : host.isReady ? 'ready' : 'away',
        state: read?.state ?? 'idle',
        isStale: !!read?.hasAnswer && (read.isStale || !host?.isReady),
        error: read?.error ?? null,
        roots: roots.map((root) => {
          const rootKey = hostPathKey(root.path)
          const inRoot = (read?.members ?? []).filter((member) => hostPathKey(member.rootPath) === rootKey)
          return {
            root,
            member: inRoot.find((member) => !member.discovered) ?? null,
            found: inRoot.filter((member) => member.discovered),
            suggestions: (read?.suggestions.get(rootKey) ?? []).filter((suggestion) => !rootKeys.has(hostPathKey(suggestion.path))),
          }
        }),
      }
    })
  }

  /** Read the codebases of one host, deleted ones included, then send each host the copies it does not have. */
  async load(serverId: string): Promise<void> {
    if (!this.access.machines().some((machine) => machine.serverId === serverId)) return
    if (!this.hostStatus.has(serverId)) this.hostStatus.set(serverId, 'loading')
    const read = Promise.resolve().then(() => this.access.api(serverId).codebaseList({ includeDeleted: true }))
    this.listReads.set(serverId, read)
    try {
      const copies = await read
      // A newer read replaces this one, and a host that went away has no current answer.
      if (this.listReads.get(serverId) !== read || !this.hostStatus.has(serverId)) return
      this.copiesByHost.set(serverId, copies)
      this.forgetSettledSends(serverId)
      this.hostStatus.set(serverId, 'ready')
      this.sync()
      this.readWatchedMembers(serverId)
    } catch (error) {
      if (this.listReads.get(serverId) !== read) return
      console.error('codebase list host load failed', serverId, error)
      if (this.hostStatus.has(serverId)) this.hostStatus.set(serverId, 'unavailable')
    } finally {
      if (this.listReads.get(serverId) === read) this.listReads.delete(serverId)
    }
  }

  /** What a folder on a host holds, before it is a root. The answer has the resolved absolute path. */
  scanFolder(serverId: string, path: string): Promise<CodebaseFolderScan> {
    return this.access.api(serverId).codebaseScanFolder(path)
  }

  /**
   * Make a codebase of two or more folders, or of one container: a folder
   * that is no repository and holds two or more repositories. Each root is
   * scanned on its host, and the resolved path is stored. One project is
   * refused: it is no codebase.
   */
  async create(name: string, roots: readonly CodebaseRootChoice[]): Promise<Codebase> {
    const codebaseName = requiredName(name)
    const scannedRoots: CodebaseRoot[] = []
    for (const choice of roots) {
      const root = await this.scannedRoot(choice)
      const refusal = rootRefusal(scannedRoots, root)
      if (refusal) throw new CodebaseRootRefused(refusal)
      scannedRoots.push(root)
    }
    if (!hasEnoughRoots(scannedRoots)) throw new Error(NEW_CODEBASE_NEEDS_FOLDERS)
    return this.commit({ id: crypto.randomUUID(), name: codebaseName, roots: scannedRoots, updatedAt: this.now(), deletedAt: null })
  }

  async rename(codebaseId: string, name: string): Promise<Codebase> {
    const codebaseName = requiredName(name)
    const current = this.requiredCodebase(codebaseId)
    if (current.name === codebaseName) return current
    return this.commit({ ...current, name: codebaseName, updatedAt: nextUpdatedAt(current, this.now()) })
  }

  /**
   * Add a folder on a host of this client. The host scans it, and the resolved
   * path is stored. Throws `CodebaseRootRefused` for a folder that is already a
   * root, for a folder that is inside a root or holds one, for a folder that
   * does not exist, and when the codebase is full.
   */
  async addRoot(codebaseId: string, choice: CodebaseRootChoice): Promise<Codebase> {
    this.requiredCodebase(codebaseId)
    const root = await this.scannedRoot(choice)
    // Read again: the codebase can change while the host scans.
    const current = this.requiredCodebase(codebaseId)
    const refusal = rootRefusal(current.roots, root)
    if (refusal) throw new CodebaseRootRefused(refusal)
    const saved = await this.commit({ ...current, roots: [...current.roots, root], updatedAt: nextUpdatedAt(current, this.now()) })
    this.readChangedMembers(saved)
    return saved
  }

  /**
   * Take a root out of the codebase. No file is deleted. Throws
   * `CodebaseRootRefused` when the roots that stay are no codebase (fewer
   * than two, and no container): the person deletes the codebase.
   */
  async removeRoot(codebaseId: string, root: Pick<CodebaseRoot, 'installationId' | 'path'>): Promise<Codebase> {
    const current = this.requiredCodebase(codebaseId)
    const roots = current.roots.filter((existing) => !isSameRoot(existing, root))
    if (roots.length === current.roots.length) return current
    const refusal = rootRemovalRefusal(current.roots, root)
    if (refusal) throw new CodebaseRootRefused(refusal)
    const saved = await this.commit({ ...current, roots, updatedAt: nextUpdatedAt(current, this.now()) })
    this.readChangedMembers(saved)
    return saved
  }

  /** Delete a codebase on each host. The delete is a copy with `deletedAt`, so it moves as a save does. No file is deleted. */
  async delete(codebaseId: string): Promise<void> {
    const current = this.requiredCodebase(codebaseId)
    const deletedAt = nextUpdatedAt(current, this.now())
    await this.commit({ ...current, updatedAt: deletedAt, deletedAt })
    for (const key of this.memberReads.keys()) {
      if (key.startsWith(`${codebaseId}\n`)) this.dropMemberRead(key)
    }
  }

  /** A view shows the members of a codebase: read them now, and again when a host is ready or the roots change. */
  watchMembers(codebaseId: string): () => void {
    this.membersWatched.set(codebaseId, (this.membersWatched.get(codebaseId) ?? 0) + 1)
    void this.refreshMembers(codebaseId)
    return () => {
      const count = (this.membersWatched.get(codebaseId) ?? 1) - 1
      if (count > 0) this.membersWatched.set(codebaseId, count)
      else this.membersWatched.delete(codebaseId)
    }
  }

  /** Read the members of a codebase from the disk of each ready host that a root names. */
  async refreshMembers(codebaseId: string): Promise<void> {
    const codebase = this.codebaseOf(codebaseId)
    if (!codebase) return
    await Promise.all(this.readyHostsOf(codebase).map((host) => this.readMembers(codebase, host)))
  }

  private installationIdOf(serverId: string): string | null {
    return this.access.machines().find((machine) => machine.serverId === serverId)?.installationId ?? null
  }

  private requiredCodebase(codebaseId: string): Codebase {
    const codebase = this.codebaseOf(codebaseId)
    if (!codebase) throw new Error('This codebase does not exist.')
    return codebase
  }

  private async scannedRoot(choice: CodebaseRootChoice): Promise<CodebaseRoot> {
    const installationId = this.installationIdOf(choice.serverId)
    if (!installationId) throw new Error('This host is not ready. Wait until it is connected, then try again.')
    const scan = await this.access.api(choice.serverId).codebaseScanFolder(choice.path)
    if (scan.state === 'missing') throw new CodebaseRootRefused('missing')
    return rootFor(installationId, scan)
  }

  /**
   * A change by the person: show it now, and send it to each host whose list
   * was read. A host that is read later gets it from `sync`. When no host
   * keeps the change, the list shows the earlier copy again and the error goes
   * to the caller.
   */
  private async commit(next: Codebase): Promise<Codebase> {
    const readyHostIds = [...this.hostStatus].filter(([, status]) => status === 'ready').map(([serverId]) => serverId)
    if (readyHostIds.length === 0) throw new Error('No host is ready. Connect a host, then try again.')
    const previous = this.newest.get(next.id)
    this.newest.set(next.id, next)
    const results = await Promise.allSettled(readyHostIds.map((serverId) => this.send(serverId, next)))
    const failures = results.filter((result) => result.status === 'rejected')
    if (failures.length === results.length) {
      if (this.newest.get(next.id) === next) {
        if (previous) this.newest.set(next.id, previous)
        else this.newest.delete(next.id)
      }
      const reason: unknown = failures[0]?.reason
      throw reason instanceof Error ? reason : new Error('No host saved the codebase.')
    }
    return this.newest.get(next.id) ?? next
  }

  /** Merge every copy this client knows, and send each ready host the copies it does not have. */
  private sync(): void {
    const merged = mergeCodebases(new Map([...this.copiesByHost, [CLIENT_COPIES, [...this.newest.values()]]]))
    for (const codebase of merged.codebases) {
      if (this.newest.get(codebase.id)?.updatedAt !== codebase.updatedAt) this.newest.set(codebase.id, codebase)
    }
    for (const [serverId, copies] of merged.stale) {
      if (this.hostStatus.get(serverId) !== 'ready') continue
      for (const copy of copies) void this.send(serverId, copy)
    }
  }

  /** Send one copy to one host, one time. The host answers the copy it keeps. */
  private send(serverId: string, copy: Codebase): Promise<void> {
    const key = `${serverId}\n${copy.id}\n${copy.updatedAt}`
    const known = this.sends.get(key)
    if (known) return known.promise
    const pending: PendingSend = {
      isSettled: false,
      promise: Promise.resolve()
        .then(() => this.access.api(serverId).codebaseSave(copy))
        .then((kept) => {
          const copies = this.copiesByHost.get(serverId) ?? []
          this.copiesByHost.set(serverId, [...copies.filter((existing) => existing.id !== kept.id), kept])
          // The host has a newer copy: that copy is the current one, and the other hosts get it.
          if (kept.updatedAt > copy.updatedAt) this.sync()
        })
        .finally(() => { pending.isSettled = true }),
    }
    this.sends.set(key, pending)
    // Reported one time here: `sync` does not wait for the answer.
    pending.promise.catch((error) => console.error('codebase send failed', serverId, error))
    return pending.promise
  }

  private forgetSettledSends(serverId: string): void {
    for (const [key, pending] of this.sends) {
      if (pending.isSettled && key.startsWith(`${serverId}\n`)) this.sends.delete(key)
    }
  }

  /** A host that went away: its list has no current read, and its members stay as its last answer. */
  private forgetHost(serverId: string): void {
    this.hostStatus.delete(serverId)
    this.listReads.delete(serverId)
    for (const [key, read] of this.memberReads) {
      if (!key.endsWith(`\n${serverId}`)) continue
      // An answer that is still on its way is not a current one.
      this.memberReadTokens.delete(key)
      if (read.hasAnswer) this.memberReads.set(key, { ...read, state: 'ready', isStale: true })
      else this.memberReads.delete(key)
    }
  }

  private dropMemberRead(key: string): void {
    this.memberReads.delete(key)
    this.memberReadTokens.delete(key)
  }

  private readyHostsOf(codebase: Codebase): CodebaseHost[] {
    const hosts: CodebaseHost[] = []
    for (const installationId of rootInstallationIds(codebase)) {
      const host = this.hostOf(installationId)
      if (host && this.hostStatus.get(host.serverId) === 'ready') hosts.push(host)
    }
    return hosts
  }

  /** The list of a host was read: read the members that a view shows when the host has no current answer for them. */
  private readWatchedMembers(serverId: string): void {
    for (const codebaseId of this.membersWatched.keys()) {
      const codebase = this.codebaseOf(codebaseId)
      if (codebase) this.readChangedMembers(codebase, serverId)
    }
  }

  /** Read the members of a codebase again on each ready host whose roots changed or whose answer is not current. */
  private readChangedMembers(codebase: Codebase, onlyServerId?: string): void {
    const namedHostIds = new Set<string>()
    for (const host of this.readyHostsOf(codebase)) {
      namedHostIds.add(host.serverId)
      if (onlyServerId && host.serverId !== onlyServerId) continue
      const read = this.memberReads.get(memberReadKey(codebase.id, host.serverId))
      if (!read && !this.membersWatched.has(codebase.id)) continue
      const isCurrent = read && !read.isStale && read.state !== 'error' && read.rootsKey === hostRootsKey(codebase, host.installationId ?? '')
      if (!isCurrent) void this.readMembers(codebase, host)
    }
    if (onlyServerId) return
    // A host that the roots no longer name has no members of this codebase.
    for (const key of this.memberReads.keys()) {
      if (!key.startsWith(`${codebase.id}\n`)) continue
      const serverId = key.slice(codebase.id.length + 1)
      const isNamed = namedHostIds.has(serverId) || rootInstallationIds(codebase).some((installationId) => this.hostOf(installationId)?.serverId === serverId)
      if (!isNamed) this.dropMemberRead(key)
    }
  }

  private async readMembers(codebase: Codebase, host: CodebaseHost): Promise<void> {
    if (!host.installationId) return
    const key = memberReadKey(codebase.id, host.serverId)
    const previous = this.memberReads.get(key) ?? NOT_READ
    const rootsKey = hostRootsKey(codebase, host.installationId)
    const token = ++this.memberReadCount
    this.memberReadTokens.set(key, token)
    const isCurrent = () => this.memberReadTokens.get(key) === token
    this.memberReads.set(key, { ...previous, state: 'loading', error: null, rootsKey })
    try {
      const api = this.access.api(host.serverId)
      // A host reads its members from the roots of the copy it keeps: a host with no copy, or an older one, gets the copy first.
      const kept = this.copiesByHost.get(host.serverId)?.find((copy) => copy.id === codebase.id)
      if ((kept?.updatedAt ?? -1) < codebase.updatedAt) await this.send(host.serverId, codebase)
      const members = await api.codebaseMembers(codebase.id)
      if (!isCurrent()) return
      const answered: MemberRead = { members, suggestions: previous.suggestions, state: 'ready', isStale: false, hasAnswer: true, error: null, rootsKey }
      this.memberReads.set(key, answered)
      // The members answer has no suggestions: the scan of each root that exists gives them.
      const suggestions = new Map<string, CodebaseFolderSuggestion[]>()
      for (const member of members) {
        if (member.discovered || member.state === 'missing') continue
        const scan = await api.codebaseScanFolder(member.path).catch(() => null)
        if (!isCurrent()) return
        if (scan?.suggestions.length) suggestions.set(hostPathKey(member.path), scan.suggestions)
      }
      this.memberReads.set(key, { ...answered, suggestions })
    } catch (error) {
      if (!isCurrent()) return
      this.memberReads.set(key, {
        ...previous,
        state: 'error',
        isStale: previous.hasAnswer,
        error: error instanceof Error ? error.message : 'The host did not answer.',
        rootsKey,
      })
    }
  }
}

export const codebasesStore = new CodebasesStore()

// Each project list of the client asks this store which folders are containers.
provideContainerRule((serverId, path) => codebasesStore.isContainerRoot(serverId, path))
