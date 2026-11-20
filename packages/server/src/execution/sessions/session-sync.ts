import { cp, mkdir, mkdtemp, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Actor } from '../../admission/actor'
import type { Principal } from '../../admission/principal'
import type { StatusCardState, StatusCardStep, AgentId, GitCheckout } from '@solus/contracts/types'
import { encodePathAsFolder } from '@solus/contracts/types'
import type { SessionPrepareRequest, SessionPrepareResult, SessionSyncFailure } from '@solus/contracts/rpc'
import { getDb } from '../../db'
import { getSessionRecord, upsertOwnSessionRecord } from '../../data/sessions/session-records'
import { readSessionStorage } from '../../data/sessions/session-storage'
import { existingDispatchCheckout } from '../../project-config/dispatch-checkouts'
import { projectsRootFor, chatFolderFor } from '../../workspace'
import { restoreSessionCode, CodeRestoreError } from '../../git/session-code-restore'
import { writeMissingCopiedFiles } from '../../git/worktree-include'
import { runAsync } from '../../git/exec'
import { createLogger } from '../../logger'
import { SessionBundleDivergedError, SessionRepositories, sessionRepositoryName } from '../../sync/sessions/session-repository'
import { SeatRequiredError } from '../seats/seat-manager'
import type { TurnSeat } from '../seats/seat-manager'
import type { PrepareDispatchCheckout } from './dispatch-repository'
import type { SessionRuntime } from '../session-runtime'

const log = createLogger('SessionSync', 'session-sync.ts')
const steps = ['fetch', 'preflight', 'checkout', 'thread', 'records'] as const
type Step = typeof steps[number]

export type SourceBundle =
  | { state: 'ready'; repositoryPath: string; head: string; source?: 'cloud' | 'host' }
  | { state: 'current' | 'diverged' | 'no-repository' | 'commit-failed' }

/** What a host asks a source of a session repository for. */
export interface SessionSourceRequest {
  sessionId: string
  /** The head of the local copy; null when this host has none. */
  have: string | null
  /** The head the client named; null when it named none. */
  wantedHead: string | null
  /** The last run host, as the client named it. */
  sourceHostId: string | undefined
  /** Where the source writes what it fetched. */
  outFile: string
  signal: AbortSignal
  actor: Actor
}

/** A place a session repository comes from: the cloud copy or the last run host. */
export type SessionSource = (request: SessionSourceRequest) => Promise<SourceBundle>

export type SessionSyncResult =
  | { state: 'current'; head: string }
  | { state: 'failed'; reason: SessionSyncFailure; message: string }

export class SessionSyncError extends Error {
  constructor(readonly reason: SessionSyncFailure, message: string) { super(message) }
}

export interface SessionSyncDeps {
  repositories: SessionRepositories
  providerInstalled(provider: AgentId): Promise<boolean>
  fetchBundle: SessionSource
  prepareCheckout: PrepareDispatchCheckout
  claimSession?: (sessionId: string, principal: Principal, isProject: boolean) => Promise<void>
}

/** Makes one host current for a session. A second caller joins the same work. */
export class SessionSync {
  private readonly running = new Map<string, { promise: Promise<SessionSyncResult>; controller: AbortController }>()
  private readonly notes = new Map<string, { from: string; to: string }>()
  private readonly workingDirectories = new Map<string, string>()

  constructor(private readonly rt: SessionRuntime, private readonly deps: SessionSyncDeps) {}

  localHead(sessionId: string): string | null {
    return readSessionStorage(sessionId)?.head ?? null
  }

  prepare(request: SessionPrepareRequest, actor: Actor, deviceId?: string): SessionPrepareResult {
    const head = this.localHead(request.sessionId)
    if (!request.knownHead || request.knownHead === head) return { state: 'current', head }
    if (!this.running.has(request.sessionId)) {
      const controller = new AbortController()
      const promise = this.sync(request, actor, deviceId, controller.signal)
        .finally(() => { if (this.running.get(request.sessionId)?.controller === controller) this.running.delete(request.sessionId) })
      this.running.set(request.sessionId, { controller, promise })
    }
    return { state: 'started' }
  }

  async wait(sessionId: string): Promise<SessionSyncResult | null> {
    return await this.running.get(sessionId)?.promise ?? null
  }

  isRunning(sessionId: string): boolean { return this.running.has(sessionId) }

  workingDirectory(sessionId: string): string | undefined { return this.workingDirectories.get(sessionId) }

  stop(sessionId: string): boolean {
    const active = this.running.get(sessionId)
    if (!active) return false
    active.controller.abort(new Error('Interrupted'))
    return true
  }

  takeNote(sessionId: string): { from: string; to: string } | undefined {
    const note = this.notes.get(sessionId)
    this.notes.delete(sessionId)
    return note
  }

  // The ordered sync owns its cleanup across all five stages.
  // eslint-disable-next-line complexity
  private async sync(request: SessionPrepareRequest, actor: Actor, deviceId: string | undefined, signal: AbortSignal): Promise<SessionSyncResult> {
    const { sessionId } = request
    const checklist: StatusCardStep[] = steps.map((id) => ({ id, label: id === 'thread' ? 'Importing thread files' : id === 'checkout' ? 'Restoring code' : id === 'records' ? 'Adopting session records' : id === 'fetch' ? 'Fetching session repository' : 'Checking provider', status: 'pending' }))
    const publish = (step: Step, status: StatusCardStep['status'], detail?: string, reason?: SessionSyncFailure, isCurrent = false): void => {
      const item = checklist.find((entry) => entry.id === step)!
      item.status = status
      if (detail) item.detail = detail
      const isDone = isCurrent || (step === 'records' && status === 'done')
      const card: StatusCardState = {
        id: `session-sync-${sessionId}`, title: status === 'error' ? 'Session sync failed' : isDone ? 'Session ready' : `Syncing from ${request.sourceHostId ?? 'another host'}…`,
        icon: 'server', status: status === 'error' ? 'error' : isDone ? 'done' : 'active', steps: (isCurrent ? checklist.slice(0, 1) : checklist).map((entry) => ({ ...entry })),
      }
      if (reason) card.syncFailureReason = reason
      this.rt.publish(sessionId, { type: 'status_card', card })
      log.info('session_sync_step', { sessionId, step, status })
    }
    const scratch = await mkdtemp(join(tmpdir(), 'solus-session-sync-'))
    const local = readSessionStorage(sessionId)
    const stagingRoot = join(scratch, 'repositories')
    let currentStep: Step = 'fetch'
    let newWorktree: { projectRoot: string; path: string } | null = null
    try {
      // The manifest is in the source bundle. Nothing local changes before it is read.
      publish('fetch', 'active')
      signal.throwIfAborted()
      const fetched = await this.deps.fetchBundle({
        sessionId, have: local?.head ?? null, wantedHead: request.knownHead, sourceHostId: request.sourceHostId,
        outFile: join(scratch, 'source.bundle'), signal, actor,
      })
      signal.throwIfAborted()
      if (fetched.state === 'current' && local?.head) {
        publish('fetch', 'done', undefined, undefined, true)
        return { state: 'current', head: local.head }
      }
      if (fetched.state !== 'ready') throw new SessionSyncError(fetched.state === 'diverged' ? 'diverged' : fetched.state === 'commit-failed' ? 'commit-failed' : 'no-repository', `Source host returned ${fetched.state}.`)
      const repository = local?.repository ?? sessionRepositoryName('staging', sessionId)
      const staged = new SessionRepositories(stagingRoot).named(repository, signal)
      const localPath = this.deps.repositories.named(repository).path
      if (existsSync(localPath)) {
        await mkdir(stagingRoot, { recursive: true })
        await cp(localPath, staged.path, { recursive: true })
      }
      const wasRefused = !!readSessionStorage(sessionId)?.pushRefusedHead && fetched.source === 'cloud'
      const head = await staged.fetchBundle(fetched.repositoryPath, wasRefused)
      const manifest = await staged.readManifest(head)
      if (manifest.session.id !== sessionId) throw new SessionSyncError('diverged', 'The bundle names another session.')
      if (local && repository !== sessionRepositoryName(manifest.session.organizationId, sessionId)) throw new SessionSyncError('diverged', 'The bundle names another organization.')
      publish('fetch', 'done')
      currentStep = 'preflight'
      publish('preflight', 'active')
      signal.throwIfAborted()
      const active = manifest.lineage?.at(-1) ?? manifest.threads.at(-1)
      if (!active || (active.provider !== 'claude-code' && active.provider !== 'codex')) throw new SessionSyncError('provider-unavailable', 'The active provider is not supported on this host.')
      const provider: AgentId = active.provider
      const metadata = this.rt.getMetadataFor(provider)
      if (!metadata) throw new SessionSyncError('provider-unavailable', `The ${provider} provider is not installed on this host.`)
      const model = manifest.session.model
      if (model && metadata.models?.length && !metadata.models.some((entry) => entry.id === model) && !metadata.modelProfiles?.[model]) {
        throw new SessionSyncError('model-unavailable', `The ${model} model is not available on this host.`)
      }
      const seats = new Map<AgentId, TurnSeat | null>()
      for (const thread of manifest.threads) {
        if (thread.provider !== 'claude-code' && thread.provider !== 'codex') throw new SessionSyncError('provider-unavailable', `The ${thread.provider} provider is not supported on this host.`)
        if (seats.has(thread.provider)) continue
        const threadMetadata = this.rt.getMetadataFor(thread.provider)
        if (!threadMetadata || threadMetadata.available === false || !await this.deps.providerInstalled(thread.provider) || !this.rt.backendFor(thread.provider).importThread) {
          throw new SessionSyncError('provider-unavailable', `The ${thread.provider} provider is not installed on this host.`)
        }
        try { seats.set(thread.provider, await this.rt.seatForTurn(actor, thread.provider)) }
        catch (error) { if (error instanceof SeatRequiredError) throw new SessionSyncError('seat-required', error.message); throw error }
      }
      signal.throwIfAborted()
      publish('preflight', 'done')
      currentStep = 'checkout'
      publish('checkout', 'active')
      signal.throwIfAborted()
      let cwd = manifest.project ? '' : chatFolderFor(sessionId, actor.principal)
      let projectRoot: string | null = null
      let gitCheckout: GitCheckout | null = null
      if (manifest.project) {
        const key = manifest.project.repositoryKey
        projectRoot = key ? existingDispatchCheckout(projectsRootFor(actor.principal), key) : null
        if (!projectRoot && request.repository) {
          projectRoot = await this.deps.prepareCheckout(request.repository, { principal: actor.principal, deviceId }, { signal, onOutput: () => {} }, 'repository')
        }
        if (!projectRoot) throw new SessionSyncError('no-project-checkout', 'This host has no checkout of the project.')
        const turn = manifest.turns.at(-1)
        if (!turn?.head?.sha || !turn.head.branch) throw new SessionSyncError('code-restore', 'The session has no branch tip to restore.')
        const bundleFiles: string[] = []
        for (const [index, entry] of manifest.turns.entries()) {
          if (entry.bundle?.kind === 'too-large' || entry.bundle?.kind === 'failed') throw new SessionSyncError('code-restore', 'The session code bundle is unavailable.')
          if (entry.bundle?.kind !== 'written') continue
          const file = join(scratch, `code-${index}.bundle`)
          await staged.appendFiles(head, [`code/${index}.bundle`], file)
          bundleFiles.push(file)
        }
        const previousCheckout = this.rt.sessionCheckouts.getGitContext(sessionId)
        const previousRecord = local?.head ? await getSessionRecord(manifest.session.organizationId, sessionId) : null
        const previousManifest = local?.head ? await this.deps.repositories.named(local.repository, signal).readManifest(local.head) : null
        const previousTree = previousManifest?.turns.at(-1)?.snapshots.at(-1)?.toTreeSha
        const restored = await restoreSessionCode({
          projectRoot, sessionId, bundleFiles, baseSha: manifest.project.baseSha,
          snapshots: manifest.turns.flatMap((entry) => entry.snapshots),
          branch: turn.head.branch, headSha: turn.head.sha, ownsWorktree: manifest.project.ownsWorktree,
          sessionPaths: manifest.sessionPaths?.sessionChangedFiles ?? [], signal,
          previousWorktree: previousTree && (previousCheckout?.worktreePath || previousRecord?.cwd)
            ? { path: previousCheckout?.worktreePath ?? previousRecord!.cwd!, treeSha: previousTree } : undefined,
        })
        cwd = restored.worktreePath
        gitCheckout = restored.checkout
        if (!restored.reusedWorktree) newWorktree = { projectRoot, path: cwd }
        if (request.repository?.files?.length) await writeMissingCopiedFiles(cwd, request.repository.files)
      }
      signal.throwIfAborted()
      publish('checkout', 'done')
      currentStep = 'thread'
      publish('thread', 'active')
      signal.throwIfAborted()
      for (const member of manifest.lineage?.length ? manifest.lineage : manifest.threads) {
        if (member.provider !== 'claude-code' && member.provider !== 'codex') throw new SessionSyncError('provider-unavailable', `The ${member.provider} provider is not installed.`)
        const thread = manifest.threads.find((entry) => entry.threadId === member.threadId)
        if (!thread) throw new SessionSyncError('failed', `Thread ${member.threadId} is missing from the manifest.`)
        const files = []
        for (const file of thread.files) {
          const path = join(scratch, `thread-${files.length}-${member.threadId}`)
          await staged.writeThreadFile(head, member.threadId, file, path)
          files.push({ relativePath: file.relativePath, path })
        }
        const backend = this.rt.backendFor(member.provider)
        if (!backend.importThread) throw new SessionSyncError('provider-unavailable', `${member.provider} cannot import its thread.`)
        const result = await backend.importThread({ sessionId, threadId: member.threadId, files, cwd, signal, seat: seats.get(member.provider) ?? undefined, replaceConflicts: wasRefused })
        if (result.files.some((file) => file.status === 'conflict')) throw new SessionSyncError('thread-conflict', `Thread ${member.threadId} differs on this host.`)
      }
      signal.throwIfAborted()
      publish('thread', 'done')
      currentStep = 'records'
      publish('records', 'active')
      signal.throwIfAborted()
      const activeProvider = active.provider
      await this.deps.claimSession?.(sessionId, actor.principal, !!projectRoot)
      signal.throwIfAborted()
      await upsertOwnSessionRecord({
        sessionId, provider: activeProvider, projectPath: encodePathAsFolder(cwd), cwd, projectRoot,
        title: manifest.session.title ?? null, model: manifest.session.model ?? null,
        reasoningEffort: manifest.session.reasoningEffort ?? null,
        startedBy: manifest.session.startedBy ?? null,
        parentSessionId: manifest.session.parentSessionId ?? null, rootSessionId: manifest.session.rootSessionId ?? null,
        isWorktree: !!projectRoot, branch: manifest.turns.at(-1)?.head?.branch ?? null,
        lastActivityAt: manifest.turns.at(-1)?.endedAt ?? Date.now(),
      }, { bornSettled: true })
      if (manifest.session.permissionMode) this.rt.sessionPermissionModes.set(sessionId, manifest.session.permissionMode)
      signal.throwIfAborted()
      const finalRepository = local?.repository ?? sessionRepositoryName(manifest.session.organizationId, sessionId)
      await this.deps.repositories.named(finalRepository, signal).fetchBundle(fetched.repositoryPath, wasRefused)
      getDb().prepare('INSERT INTO session_storage (session_id, repository, head, turn_count) VALUES (?, ?, ?, ?) ON CONFLICT(session_id) DO UPDATE SET head = excluded.head, turn_count = excluded.turn_count')
        .run(sessionId, finalRepository, head, manifest.turns.length)
      // A fetched cloud head is already pushed.
      if (fetched.source === 'cloud') {
        getDb().prepare('UPDATE session_storage SET pushed_head = ?, reported_head = ?, push_refused_head = NULL, push_error = NULL WHERE session_id = ?').run(head, head, sessionId)
      }
      if (gitCheckout) this.rt.sessionCheckouts.setSessionGitEnvironment(sessionId, cwd, gitCheckout)
      this.workingDirectories.set(sessionId, cwd)
      if (manifest.lastProjectRoot && manifest.lastProjectRoot !== (projectRoot ?? cwd)) {
        this.notes.set(sessionId, { from: manifest.lastProjectRoot, to: projectRoot ?? cwd })
      }
      publish('records', 'done')
      return { state: 'current', head }
    } catch (error) {
      const reason: SessionSyncFailure = signal.aborted ? 'interrupted' : error instanceof SessionSyncError ? error.reason : error instanceof SessionBundleDivergedError ? 'diverged' : error instanceof CodeRestoreError ? 'code-restore' : 'failed'
      const message = error instanceof Error ? error.message : String(error)
      publish(currentStep, 'error', message, reason)
      if (newWorktree) await runAsync('git', ['worktree', 'remove', '--force', newWorktree.path], newWorktree.projectRoot).catch(() => {})
      log.info('session_sync_failed', { sessionId, reason, message })
      return { state: 'failed', reason, message }
    } finally {
      await rm(scratch, { recursive: true, force: true })
    }
  }
}
