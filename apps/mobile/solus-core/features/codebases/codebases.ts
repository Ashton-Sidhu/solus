import type { HostApi } from '@solus/client-core/host-api'
import {
  CodebaseRootRefused,
  codebasesHolding,
  formsCodebaseFor,
  hostRootsKey,
  isSameRoot,
  liveCodebases,
  mergeCodebases,
  nextUpdatedAt,
  rootFor,
  rootInstallationIds,
  rootRefusal,
} from '@solus/client-core/codebases'
import type {
  Codebase,
  CodebaseFolderScan,
  CodebaseFolderSuggestion,
  CodebaseMember,
  CodebaseRoot,
} from '@solus/contracts/codebases'
import type { HostEventMap, HostEventName } from '@solus/contracts/host-events'
import { hostPathKey } from '@solus/contracts/host-path'
import { Listeners } from '../../lib/listeners'

/**
 * The codebases of this phone (docs/plans/codebases.md decision 6 and §10).
 * The rules are the rules of the desktop and web store
 * (`contexts/codebases/codebases.store.svelte.ts`): each host keeps the full
 * record of each codebase. This model reads the copies of each connected host,
 * shows the newest copy of each codebase, and sends that copy to each host
 * that has an older one or none. A change by the person goes to each connected
 * host; a host that is away gets it when it is ready again. The members of a
 * codebase are not in the record: each host reads them from its disk when a
 * screen asks.
 *
 * Every copy belongs to one account and one organization (`scope`). A change
 * of the scope forgets every copy, and an answer that was asked for in the
 * earlier scope is dropped.
 */

export type CodebaseHostApi = Pick<HostApi, 'codebaseList' | 'codebaseSave' | 'codebaseMembers' | 'codebaseScanFolder'>

export interface CodebaseHostConnection {
  readonly api: CodebaseHostApi
  readonly events: { subscribe<K extends HostEventName>(type: K, listener: (payload: HostEventMap[K]) => void): () => void }
}

/** One host of this phone that can run work. */
export interface CodebaseMachine {
  /** This phone's id for the host. */
  hostId: string
  /** The id that a root names this host by (decision 2). */
  installationId: string
  label: string
  /** The connection of the host while this phone can do work on it and may use it. Null while the host is away. */
  connection: CodebaseHostConnection | null
  /** The server session of the connection. A new one means the host must be read again. */
  generation: number
}

export interface CodebasesDeps {
  /** The account and the organization that every read and every send belongs to. */
  scope(): string
  /** Each host of this phone. The workspace service is not one: it keeps no codebases. */
  machines(): CodebaseMachine[]
  /** A host, a connection, or the account changed. */
  onChange(listener: () => void): () => void
  uuid(): string
  now?(): number
}

/** `unavailable`: the host answered with an error, for example an older host without codebases. */
export type CodebaseHostStatus = 'loading' | 'ready' | 'unavailable'

export interface CodebaseHost {
  hostId: string
  installationId: string
  label: string
  /** This phone can do work on the host now. */
  isReady: boolean
  /** The read of the host's codebases. Null while the host is away. */
  status: CodebaseHostStatus | null
}

/** A folder on a host of this phone, before it is a root. */
export interface CodebaseRootChoice {
  hostId: string
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

/** `unknown`: no host of this phone has the installation id that the roots name. */
export type CodebaseHostPresence = 'ready' | 'away' | 'unknown'

/** The roots of one codebase on one host, with what that host read from its disk. */
export interface CodebaseHostMembers {
  installationId: string
  /** This phone's id for the host. Null when this phone does not know the host. */
  hostId: string | null
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

/** The connection that the list of a host was read on, and the watch of its `codebases.changed` event. */
interface FollowedHost {
  connection: CodebaseHostConnection
  generation: number
  stop: () => void
}

/** The key of this phone's own copies in the merge. No host has this id. */
const CLIENT_COPIES = '\u0000client'

const NOT_READ: MemberRead = { members: [], suggestions: new Map(), state: 'loading', isStale: false, hasAnswer: false, error: null, rootsKey: '' }

function memberReadKey(codebaseId: string, hostId: string): string {
  return `${codebaseId}\n${hostId}`
}

function requiredName(name: string): string {
  const trimmed = name.trim()
  if (!trimmed) throw new Error('A codebase needs a name.')
  return trimmed
}

export class Codebases {
  /** Every change of what the answers below give. */
  readonly changes = new Listeners()
  /** The newest copy that this phone knows of each codebase, by id. A deleted codebase is here as its tombstone. */
  private readonly newest = new Map<string, Codebase>()
  private readonly hostStatus = new Map<string, CodebaseHostStatus>()
  private readonly memberReads = new Map<string, MemberRead>()
  /** The last answer of each host, deleted copies included. Kept while a host is away. */
  private readonly copiesByHost = new Map<string, Codebase[]>()
  private readonly listReads = new Map<string, Promise<Codebase[]>>()
  /** One send for each host and copy, until the host is read again: a host that refuses a copy is not asked in a loop. */
  private readonly sends = new Map<string, PendingSend>()
  /** The newest read of each host's members. A token is never used again, so an old answer cannot look current. */
  private readonly memberReadTokens = new Map<string, number>()
  private memberReadCount = 0
  private readonly membersWatched = new Map<string, number>()
  /** What the folder of a draft holds, by host and path: the last answer of its host. */
  private readonly folderScans = new Map<string, CodebaseFolderScan>()
  private readonly followed = new Map<string, FollowedHost>()
  private watchCount = 0
  private stopWatching: (() => void) | null = null
  private scope: string
  /** Rises when the scope changes. An answer of an earlier scope is dropped. */
  private scopeCount = 0
  private changeCount = 0
  private liveList: { at: number; codebases: Codebase[] } | null = null

  constructor(private readonly deps: CodebasesDeps) {
    this.scope = deps.scope()
  }

  /** A number that rises with each change: a screen reads the answers again when it differs. */
  get revision(): number {
    return this.changeCount
  }

  /** Screens that show codebases hold one shared watch over every host. */
  watch(): () => void {
    if (this.watchCount++ === 0) {
      this.stopWatching = this.deps.onChange(() => this.followHosts())
      this.followHosts()
    }
    return () => {
      if (--this.watchCount > 0) return
      this.stopWatching?.()
      this.stopWatching = null
      for (const host of this.followed.values()) host.stop()
      this.followed.clear()
    }
  }

  /** The hosts of this phone, with the state of the read of their codebases. */
  hosts(): CodebaseHost[] {
    return this.deps.machines().map((machine) => ({
      hostId: machine.hostId,
      installationId: machine.installationId,
      label: machine.label,
      isReady: machine.connection !== null,
      status: this.hostStatus.get(machine.hostId) ?? null,
    }))
  }

  /** The host of this phone that a root names; null when this phone does not know it. */
  hostOf(installationId: string): CodebaseHost | null {
    const hosts = this.hosts()
    return hosts.find((host) => host.installationId === installationId)
      ?? hosts.find((host) => host.hostId === installationId)
      ?? null
  }

  /** The codebases that are not deleted, by name. The same list until a change. */
  codebases(): Codebase[] {
    if (this.liveList?.at !== this.changeCount) {
      this.liveList = { at: this.changeCount, codebases: liveCodebases(this.newest.values()) }
    }
    return this.liveList.codebases
  }

  /** One codebase that is not deleted. */
  codebaseOf(codebaseId: string): Codebase | undefined {
    const codebase = this.newest.get(codebaseId)
    return codebase && codebase.deletedAt === null ? codebase : undefined
  }

  /** The codebases that hold a folder on a host of this phone: the folder is a root, or it is inside a root. */
  codebasesOfFolder(hostId: string, path: string): Codebase[] {
    const installationId = this.installationIdOf(hostId)
    return installationId ? codebasesHolding(this.codebases(), installationId, path) : []
  }

  /**
   * The roots of one codebase, grouped by host, with the members that each
   * host read. A host that is away keeps its last answer with `isStale`. A
   * root on a host that this phone does not know stays in the list with
   * `presence: 'unknown'`.
   */
  membersOf(codebaseId: string): CodebaseHostMembers[] {
    const codebase = this.codebaseOf(codebaseId)
    if (!codebase) return []
    return rootInstallationIds(codebase).map((installationId) => {
      const host = this.hostOf(installationId)
      const read = host ? this.memberReads.get(memberReadKey(codebaseId, host.hostId)) : undefined
      const roots = codebase.roots.filter((root) => root.installationId === installationId)
      const rootKeys = new Set(roots.map((root) => hostPathKey(root.path)))
      return {
        installationId,
        hostId: host?.hostId ?? null,
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
  async load(hostId: string): Promise<void> {
    this.followScope()
    const connection = this.connectionOf(hostId)
    if (!connection) return
    if (!this.hostStatus.has(hostId)) this.setStatus(hostId, 'loading')
    const read = Promise.resolve().then(() => connection.api.codebaseList({ includeDeleted: true }))
    this.listReads.set(hostId, read)
    try {
      const copies = await read
      // A newer read replaces this one, and a host that went away or a new scope has no current answer.
      if (this.listReads.get(hostId) !== read || !this.hostStatus.has(hostId)) return
      this.copiesByHost.set(hostId, copies)
      this.forgetSettledSends(hostId)
      this.setStatus(hostId, 'ready')
      this.sync()
      this.readWatchedMembers(hostId)
    } catch (error) {
      if (this.listReads.get(hostId) !== read) return
      console.error('codebase list host load failed', hostId, error)
      if (this.hostStatus.has(hostId)) this.setStatus(hostId, 'unavailable')
    } finally {
      if (this.listReads.get(hostId) === read) this.listReads.delete(hostId)
    }
  }

  /** What a folder on a host holds, before it is a root. The answer has the resolved absolute path. */
  scanFolder(hostId: string, path: string): Promise<CodebaseFolderScan> {
    return this.requiredConnection(hostId).api.codebaseScanFolder(path)
  }

  /**
   * Read what the folder of a draft holds, and keep the answer for
   * `newCodebaseAt`. A failure keeps the last answer: the host decides at the
   * first prompt.
   */
  async readFolder(hostId: string, path: string): Promise<void> {
    const key = `${hostId}\n${hostPathKey(path)}`
    const token = ++this.memberReadCount
    this.memberReadTokens.set(key, token)
    const scopeCount = this.scopeCount
    const scan = await Promise.resolve().then(() => this.scanFolder(hostId, path)).catch(() => null)
    if (!scan || scopeCount !== this.scopeCount || this.memberReadTokens.get(key) !== token) return
    this.folderScans.set(key, scan)
    this.changed()
  }

  /**
   * The codebase that the host makes for a folder at the first prompt of a
   * session there (docs/plans/codebases.md decision 13): the scan of the
   * folder, whose members are the members of that codebase. Null when the
   * folder was not read, and when the host makes none.
   */
  newCodebaseAt(hostId: string, path: string): CodebaseFolderScan | null {
    const scan = this.folderScans.get(`${hostId}\n${hostPathKey(path)}`)
    const installationId = this.installationIdOf(hostId)
    return scan && installationId && formsCodebaseFor(this.newest.values(), installationId, scan) ? scan : null
  }

  /** Make a codebase. Each root is scanned on its host, and the resolved path is stored. */
  async create(name: string, roots: readonly CodebaseRootChoice[]): Promise<Codebase> {
    const codebaseName = requiredName(name)
    const scannedRoots: CodebaseRoot[] = []
    for (const choice of roots) {
      const root = await this.scannedRoot(choice)
      const refusal = rootRefusal(scannedRoots, root)
      if (refusal) throw new CodebaseRootRefused(refusal)
      scannedRoots.push(root)
    }
    return this.commit({ id: this.deps.uuid(), name: codebaseName, roots: scannedRoots, updatedAt: this.now(), deletedAt: null })
  }

  async rename(codebaseId: string, name: string): Promise<Codebase> {
    const codebaseName = requiredName(name)
    const current = this.requiredCodebase(codebaseId)
    if (current.name === codebaseName) return current
    return this.commit({ ...current, name: codebaseName, updatedAt: nextUpdatedAt(current, this.now()) })
  }

  /**
   * Add a folder on a host of this phone. The host scans it, and the resolved
   * path is stored. Throws `CodebaseRootRefused` for a folder that is already a
   * root, for a folder that does not exist, and when the codebase is full.
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

  /** Take a root out of the codebase. No file is deleted. */
  async removeRoot(codebaseId: string, root: Pick<CodebaseRoot, 'installationId' | 'path'>): Promise<Codebase> {
    const current = this.requiredCodebase(codebaseId)
    const roots = current.roots.filter((existing) => !isSameRoot(existing, root))
    if (roots.length === current.roots.length) return current
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
    this.changed()
  }

  /** A screen shows the members of a codebase: read them now, and again when a host is ready or the roots change. */
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

  /** The person removed a host from this phone: its copies and its members leave with it. */
  forgetHost(hostId: string): void {
    this.followed.get(hostId)?.stop()
    this.followed.delete(hostId)
    this.copiesByHost.delete(hostId)
    this.hostStatus.delete(hostId)
    this.listReads.delete(hostId)
    for (const key of this.sends.keys()) {
      if (key.startsWith(`${hostId}\n`)) this.sends.delete(key)
    }
    for (const key of this.memberReads.keys()) {
      if (key.endsWith(`\n${hostId}`)) this.dropMemberRead(key)
    }
    for (const key of this.folderScans.keys()) {
      if (key.startsWith(`${hostId}\n`)) this.folderScans.delete(key)
    }
    this.changed()
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now()
  }

  private changed(): void {
    this.changeCount++
    this.changes.notify()
  }

  private setStatus(hostId: string, status: CodebaseHostStatus): void {
    if (this.hostStatus.get(hostId) === status) return
    this.hostStatus.set(hostId, status)
    this.changed()
  }

  private setMemberRead(key: string, read: MemberRead): void {
    this.memberReads.set(key, read)
    this.changed()
  }

  /**
   * Follow the hosts of this phone: read a host when it is ready on a new
   * connection, and keep only the last answer of a host that went away. A new
   * account or organization starts with nothing.
   */
  private followHosts(): void {
    this.followScope()
    const machines = this.deps.machines()
    for (const hostId of new Set([...this.followed.keys(), ...this.copiesByHost.keys()])) {
      if (!machines.some((machine) => machine.hostId === hostId)) this.forgetHost(hostId)
    }
    for (const machine of machines) {
      const followed = this.followed.get(machine.hostId)
      if (!machine.connection) {
        if (followed || this.hostStatus.has(machine.hostId)) this.hostWentAway(machine.hostId)
        continue
      }
      if (followed?.connection === machine.connection && followed.generation === machine.generation) continue
      // A new server session: the answers of the earlier one are not current.
      if (followed) this.hostWentAway(machine.hostId)
      const hostId = machine.hostId
      this.followed.set(hostId, {
        connection: machine.connection,
        generation: machine.generation,
        stop: machine.connection.events.subscribe('codebases.changed', () => {
          if (this.hostStatus.has(hostId)) void this.load(hostId)
        }),
      })
      void this.load(hostId)
    }
  }

  /** The account or the organization changed: no copy, no member, and no send of the earlier one stays. */
  private followScope(): void {
    const scope = this.deps.scope()
    if (scope === this.scope) return
    this.scope = scope
    this.scopeCount++
    for (const host of this.followed.values()) host.stop()
    this.followed.clear()
    this.newest.clear()
    this.copiesByHost.clear()
    this.hostStatus.clear()
    this.listReads.clear()
    this.sends.clear()
    this.folderScans.clear()
    this.memberReads.clear()
    this.memberReadTokens.clear()
    this.changed()
  }

  private connectionOf(hostId: string): CodebaseHostConnection | null {
    return this.deps.machines().find((machine) => machine.hostId === hostId)?.connection ?? null
  }

  private requiredConnection(hostId: string): CodebaseHostConnection {
    const connection = this.connectionOf(hostId)
    if (!connection) throw new Error('This host is not ready. Wait until it is connected, then try again.')
    return connection
  }

  private installationIdOf(hostId: string): string | null {
    return this.deps.machines().find((machine) => machine.hostId === hostId)?.installationId ?? null
  }

  private requiredCodebase(codebaseId: string): Codebase {
    const codebase = this.codebaseOf(codebaseId)
    if (!codebase) throw new Error('This codebase does not exist.')
    return codebase
  }

  private async scannedRoot(choice: CodebaseRootChoice): Promise<CodebaseRoot> {
    const connection = this.requiredConnection(choice.hostId)
    const installationId = this.installationIdOf(choice.hostId)
    if (!installationId) throw new Error('This host is not ready. Wait until it is connected, then try again.')
    const scan = await connection.api.codebaseScanFolder(choice.path)
    if (scan.state === 'missing') throw new CodebaseRootRefused('missing')
    return rootFor(installationId, scan.path)
  }

  /**
   * A change by the person: show it now, and send it to each host whose list
   * was read. A host that is read later gets it from `sync`. When no host
   * keeps the change, the list shows the earlier copy again and the error goes
   * to the caller.
   */
  private async commit(next: Codebase): Promise<Codebase> {
    const readyHostIds = [...this.hostStatus].filter(([, status]) => status === 'ready').map(([hostId]) => hostId)
    if (readyHostIds.length === 0) throw new Error('No host is ready. Connect a host, then try again.')
    const scopeCount = this.scopeCount
    const previous = this.newest.get(next.id)
    this.newest.set(next.id, next)
    this.changed()
    const results = await Promise.allSettled(readyHostIds.map((hostId) => this.send(hostId, next)))
    if (scopeCount !== this.scopeCount) throw new Error('The account changed before the codebase was saved.')
    const failures = results.filter((result) => result.status === 'rejected')
    if (failures.length === results.length) {
      if (this.newest.get(next.id) === next) {
        if (previous) this.newest.set(next.id, previous)
        else this.newest.delete(next.id)
        this.changed()
      }
      const reason: unknown = failures[0]?.reason
      throw reason instanceof Error ? reason : new Error('No host saved the codebase.')
    }
    return this.newest.get(next.id) ?? next
  }

  /** Merge every copy this phone knows, and send each ready host the copies it does not have. */
  private sync(): void {
    const merged = mergeCodebases(new Map([...this.copiesByHost, [CLIENT_COPIES, [...this.newest.values()]]]))
    let hasNewer = false
    for (const codebase of merged.codebases) {
      if (this.newest.get(codebase.id)?.updatedAt === codebase.updatedAt) continue
      this.newest.set(codebase.id, codebase)
      hasNewer = true
    }
    if (hasNewer) this.changed()
    for (const [hostId, copies] of merged.stale) {
      if (this.hostStatus.get(hostId) !== 'ready') continue
      for (const copy of copies) void this.send(hostId, copy)
    }
  }

  /** Send one copy to one host, one time. The host answers the copy it keeps. */
  private send(hostId: string, copy: Codebase): Promise<void> {
    const key = `${hostId}\n${copy.id}\n${copy.updatedAt}`
    const known = this.sends.get(key)
    if (known) return known.promise
    const scopeCount = this.scopeCount
    const pending: PendingSend = {
      isSettled: false,
      promise: Promise.resolve()
        .then(() => this.requiredConnection(hostId).api.codebaseSave(copy))
        .then((kept) => {
          // The answer of an earlier account or organization is not a copy of this one.
          if (scopeCount !== this.scopeCount) return
          const copies = this.copiesByHost.get(hostId) ?? []
          this.copiesByHost.set(hostId, [...copies.filter((existing) => existing.id !== kept.id), kept])
          // The host has a newer copy: that copy is the current one, and the other hosts get it.
          if (kept.updatedAt > copy.updatedAt) this.sync()
        })
        .finally(() => { pending.isSettled = true }),
    }
    this.sends.set(key, pending)
    // Reported one time here: `sync` does not wait for the answer.
    pending.promise.catch((error) => console.error('codebase send failed', hostId, error))
    return pending.promise
  }

  private forgetSettledSends(hostId: string): void {
    for (const [key, pending] of this.sends) {
      if (pending.isSettled && key.startsWith(`${hostId}\n`)) this.sends.delete(key)
    }
  }

  /** A host that went away: its list has no current read, and its members stay as its last answer. */
  private hostWentAway(hostId: string): void {
    this.followed.get(hostId)?.stop()
    this.followed.delete(hostId)
    this.hostStatus.delete(hostId)
    this.listReads.delete(hostId)
    for (const [key, read] of this.memberReads) {
      if (!key.endsWith(`\n${hostId}`)) continue
      // An answer that is still on its way is not a current one.
      this.memberReadTokens.delete(key)
      if (read.hasAnswer) this.memberReads.set(key, { ...read, state: 'ready', isStale: true })
      else this.memberReads.delete(key)
    }
    this.changed()
  }

  private dropMemberRead(key: string): void {
    this.memberReads.delete(key)
    this.memberReadTokens.delete(key)
  }

  private readyHostsOf(codebase: Codebase): CodebaseHost[] {
    const hosts: CodebaseHost[] = []
    for (const installationId of rootInstallationIds(codebase)) {
      const host = this.hostOf(installationId)
      if (host && this.hostStatus.get(host.hostId) === 'ready') hosts.push(host)
    }
    return hosts
  }

  /** The list of a host was read: read the members that a screen shows when the host has no current answer for them. */
  private readWatchedMembers(hostId: string): void {
    for (const codebaseId of this.membersWatched.keys()) {
      const codebase = this.codebaseOf(codebaseId)
      if (codebase) this.readChangedMembers(codebase, hostId)
    }
  }

  /** Read the members of a codebase again on each ready host whose roots changed or whose answer is not current. */
  private readChangedMembers(codebase: Codebase, onlyHostId?: string): void {
    const namedHostIds = new Set<string>()
    for (const host of this.readyHostsOf(codebase)) {
      namedHostIds.add(host.hostId)
      if (onlyHostId && host.hostId !== onlyHostId) continue
      const read = this.memberReads.get(memberReadKey(codebase.id, host.hostId))
      if (!read && !this.membersWatched.has(codebase.id)) continue
      const isCurrent = read && !read.isStale && read.state !== 'error' && read.rootsKey === hostRootsKey(codebase, host.installationId)
      if (!isCurrent) void this.readMembers(codebase, host)
    }
    if (onlyHostId) return
    // A host that the roots no longer name has no members of this codebase.
    let hasDropped = false
    for (const key of this.memberReads.keys()) {
      if (!key.startsWith(`${codebase.id}\n`)) continue
      const hostId = key.slice(codebase.id.length + 1)
      const isNamed = namedHostIds.has(hostId) || rootInstallationIds(codebase).some((installationId) => this.hostOf(installationId)?.hostId === hostId)
      if (isNamed) continue
      this.dropMemberRead(key)
      hasDropped = true
    }
    if (hasDropped) this.changed()
  }

  private async readMembers(codebase: Codebase, host: CodebaseHost): Promise<void> {
    const connection = this.connectionOf(host.hostId)
    if (!connection) return
    const key = memberReadKey(codebase.id, host.hostId)
    const previous = this.memberReads.get(key) ?? NOT_READ
    const rootsKey = hostRootsKey(codebase, host.installationId)
    const token = ++this.memberReadCount
    this.memberReadTokens.set(key, token)
    const isCurrent = () => this.memberReadTokens.get(key) === token
    this.setMemberRead(key, { ...previous, state: 'loading', error: null, rootsKey })
    try {
      // A host reads its members from the roots of the copy it keeps: a host with no copy, or an older one, gets the copy first.
      const kept = this.copiesByHost.get(host.hostId)?.find((copy) => copy.id === codebase.id)
      if ((kept?.updatedAt ?? -1) < codebase.updatedAt) await this.send(host.hostId, codebase)
      const members = await connection.api.codebaseMembers(codebase.id)
      if (!isCurrent()) return
      const answered: MemberRead = { members, suggestions: previous.suggestions, state: 'ready', isStale: false, hasAnswer: true, error: null, rootsKey }
      this.setMemberRead(key, answered)
      // The members answer has no suggestions: the scan of each root that exists gives them.
      const suggestions = new Map<string, CodebaseFolderSuggestion[]>()
      for (const member of members) {
        if (member.discovered || member.state === 'missing') continue
        const scan = await connection.api.codebaseScanFolder(member.path).catch(() => null)
        if (!isCurrent()) return
        if (scan?.suggestions.length) suggestions.set(hostPathKey(member.path), scan.suggestions)
      }
      this.setMemberRead(key, { ...answered, suggestions })
    } catch (error) {
      if (!isCurrent()) return
      this.setMemberRead(key, {
        ...previous,
        state: 'error',
        isStale: previous.hasAnswer,
        error: error instanceof Error ? error.message : 'The host did not answer.',
        rootsKey,
      })
    }
  }
}
