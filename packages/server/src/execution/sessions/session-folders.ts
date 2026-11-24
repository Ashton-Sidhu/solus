import { basename, join, resolve } from 'node:path'
import type { Codebase, CodebaseMember, SessionAttachedFolder, SessionFolder, SessionFolderSource, TaskFolder } from '@solus/contracts/codebases'
import type { ExecutionPreferences } from '@solus/contracts/settings'
import { hostPathBaseName, sameHostPath } from '@solus/contracts/host-path'
import type { NormalizedEvent, PermissionMode, SessionRecordUpsert } from '@solus/contracts/types'
import type { Actor } from '../../admission/actor'
import { getInstallationId } from '../../admission/auth'
import { ANY_ORGANIZATION, organizationForNew, recordScopeOf } from '../../admission/principal'
import { getCodebase } from '../../data/codebases/codebases'
import { assertPathInScope } from '../../data/sessions/guest-path-scope'
import { resolveSessionLineageById } from '../../data/sessions/session-lineage'
import { setSessionRecordFolders, storedSessionFolders } from '../../data/sessions/session-records'
import { getIndexedSession } from '../../db/session-indexer'
import { folderStateOf, membersOf } from '../../files/codebase-members'
import { findTaskFolderContaining } from '../../git/task-folder-store'
import { readHostList } from '../../host/host-list'
import { createLogger } from '../../logger'
import { isInsideRoot, realPathOf } from '../../paths'
import { resolveHomePath } from '../../platform/paths'
import type { CodebaseBlock } from '../agents/runtime-instructions'
import type { SessionFolderGate } from '../agents/session-folder-gate'
import type { SessionRuntime } from '../session-runtime'
import { attachTargetOf, automaticAttachTarget, isInTemporaryPlace, refusalForSolusData, systemTemporaryPlaces } from './attach-target'
import { generateCodebaseName, resolveCodebaseNaming } from './codebase-name'
import { ObservedWrites } from './observed-writes'
import { codebaseForAttachedFolder, codebaseOfProjectFolder, containerCodebaseOf, formationActivity, formationFor, projectFolderOf, renameFormed, type SessionCodebase } from './session-codebase-formation'
import { addCodebaseRoot, requestAttach, type AttachCodebase, type AttachOutcome, type AttachRequestOptions, type AttachSession, type AttachState } from './session-folder-attach'

import { NOT_A_FOLDER, taskFolderStandIns, worktreeOfMember } from './task-folder-stand-ins'

export { ATTACH_CHOICE, ATTACH_QUESTION_ID, ATTACH_QUESTION_ID_PREFIX, type AttachAsker, type AttachOutcome, type AttachRequestOptions } from './session-folder-attach'

const log = createLogger('SessionRuntime', 'session-folders.ts')

/** What the name of a formed codebase reads of the preferences of a person. */
type NamingPreferences = Pick<ExecutionPreferences, 'codebaseNaming' | 'textGenerationModel'>

/** Where a session works when its folders are resolved. */
export interface SessionWorkingPlace {
  /** The one working directory of the session (`SessionCheckouts`). */
  workingDirectory: string
  /** The repository that the working directory is a checkout of, when it is a linked worktree. */
  repositoryRoot?: string | null
}

/** What a turn start gives `resolve`. */
export interface SessionFoldersTurn extends SessionWorkingPlace {
  /** The codebase that the turn names. A session with no codebase takes it. A session that has one keeps its own. */
  codebaseId?: string | null
  /** The person chose "No codebase" for the session: no rule gives it one (decision 13). */
  noCodebase?: boolean
  /** The preferences of the person of the turn: how a codebase that Solus forms gets its name, and the model that writes it. */
  preferences?: NamingPreferences
  /** The launcher settled the codebase of this turn already, before the plan of its worktree: the disk is not read a second time. */
  isCodebaseSettled?: boolean
  /** The person the turn acts for: the codebase is read in their scope. */
  actor: Actor
}

/** The fields of a session record that this owner writes. */
type SessionRecordFolders = Pick<SessionRecordUpsert, 'codebaseId' | 'attachedFolders'>

/** One resolved folder, and the path that the file system gives for it. */
interface FolderEntry {
  folder: SessionFolder
  realPath: string
  /** The folder is inside the working directory: the provider reaches it with no grant. */
  reached: boolean
}

interface SessionFoldersState extends AttachState {
  /** The folders that the session record keeps besides the members of the codebase. */
  attached: SessionAttachedFolder[]
  /** The resolved list, sorted by path. Null before the first resolve in this process. */
  entries: FolderEntry[] | null
  /** Where the session worked when the list was resolved. */
  place: SessionWorkingPlace | null
  /** The `git` folders whose checkout this session hears about. */
  watched: Set<string>
  /** The list as last published, to compare by value. */
  published: string
  /** The person of the last turn start: a provider request and a turn end act for that person. */
  actor: Actor | null
  /** The person chose "No codebase": no rule gives the session one. Kept in this process; the client names it at each turn. */
  noCodebase: boolean
  /** A turn of the session started in this process, so the choice of the person is known. */
  turnStarted: boolean
  /** The folders attached before that turn. Its start reads them for rule 2 of decision 13. */
  attachedBeforeTurn: SessionAttachedFolder[]
  /** The naming preferences of the person of the last turn start. Undefined: the defaults. */
  preferences: NamingPreferences | undefined
}

function byPath(a: FolderEntry, b: FolderEntry): number {
  return a.folder.path < b.folder.path ? -1 : a.folder.path > b.folder.path ? 1 : 0
}

/**
 * The folders of each session besides its working directory
 * (docs/plans/codebases.md §6). `SessionCheckouts` keeps the one working
 * directory. This owner keeps all other folders: the members of the session's
 * codebase on this host, and the folders attached to the session.
 * The session record is the durable copy (`codebase_id`, `attached_folders`).
 *
 * The provider gets the granted folders at each turn start (`grantedPaths`).
 * Each `git` folder is registered with the checkout service, so the session
 * gets `git_context` and `git_status` events with that folder's `cwd`.
 *
 * `attach` adds a folder with no rule. `requestAttach` is the rule in front of
 * it (decision 8): each automatic trigger and the `attach_folder` tool call it.
 * No folder of a session is in the data of Solus (`refusalForSolusData`).
 */
export class SessionFolders implements SessionFolderGate {
  private readonly sessions = new Map<string, SessionFoldersState>()
  private readonly writes = new ObservedWrites()

  /**
   * `temporaryPlaces`: the temporary directories of the system, which an
   * automatic trigger does not attach. A test that makes its folders there
   * gives its own list.
   */
  constructor(private readonly rt: SessionRuntime, private readonly temporaryPlaces: readonly string[] = systemTemporaryPlaces()) {
    rt.checkouts.onChange(({ state }) => {
      if (!state.checkout) return
      for (const [sessionId, session] of this.sessions) {
        if (session.watched.has(state.cwd)) rt.publish(sessionId, { type: 'git_context', cwd: state.cwd, gitContext: state.checkout })
      }
    })
    rt.checkouts.onStatus((cwd, status) => {
      for (const [sessionId, session] of this.sessions) {
        if (session.watched.has(cwd)) rt.publish(sessionId, { type: 'git_status', cwd, state: status })
      }
    })
  }

  /**
   * Resolve the folders of a session at a turn start: the members of its
   * codebase on this host, less the working directory and the repository that
   * the working directory is in; plus the attached folders that still exist. A member inside the working
   * directory is a folder of the session: Git status, diff, and checkpoints
   * work for each repository.
   */
  async resolve(sessionId: string, turn: SessionFoldersTurn): Promise<SessionFolder[]> {
    const state = await this.stateOf(sessionId)
    state.actor = turn.actor
    state.place = { workingDirectory: resolve(resolveHomePath(turn.workingDirectory)), repositoryRoot: turn.repositoryRoot ?? null }
    await this.dropTemporaryFolders(sessionId, state)
    if (!turn.isCodebaseSettled) await this.settleCodebase(sessionId, turn)
    // A turn that stopped before its end left its writes: they are read now.
    await this.attachObserved(sessionId)
    state.refused.clear()
    await this.refresh(sessionId, state, turn.actor)
    return this.foldersOf(sessionId)
  }

  /**
   * Clean what an earlier rule left (decision 8): an automatic trigger
   * attached the temporary directory of a pasted file, and the record of the
   * session keeps it. At a turn start, an attached folder in a temporary
   * directory of the system that nobody asked for by its name leaves the
   * record. A folder that a person or the agent asked for by its name stays,
   * and so does each folder in a different place: a person detaches it.
   */
  private async dropTemporaryFolders(sessionId: string, state: SessionFoldersState): Promise<void> {
    const kept: SessionAttachedFolder[] = []
    for (const attached of state.attached) {
      const isAutomatic = !attached.byName && (attached.source === 'attached' || attached.source === 'observed')
      if (isAutomatic && await isInTemporaryPlace(attached.path, this.temporaryPlaces)) {
        log.info('session_folder_dropped', { sessionId, path: attached.path, reason: 'temporary_place' })
        continue
      }
      kept.push(attached)
    }
    if (kept.length === state.attached.length) return
    state.attached = kept
    await setSessionRecordFolders(sessionId, { attachedFolders: kept })
  }

  /**
   * The codebase of a session for a turn that starts (decisions 5 and 13). A
   * session keeps the codebase it has. A session with none takes the one that
   * the turn names. Without one, the host gives it the one codebase that
   * holds its project folder, else the codebase of a project folder that is
   * a container, else one from a second project that was attached before the
   * turn (`session-codebase-formation.ts`). `turn` says
   * where the turn starts: the launcher calls this before the plan of a new
   * worktree, so the plan reads the members of that codebase. A failure here
   * does not stop the turn.
   */
  async settleCodebase(sessionId: string, turn: SessionFoldersTurn): Promise<void> {
    const state = await this.stateOf(sessionId)
    const attachedBefore = state.attachedBeforeTurn.splice(0)
    state.turnStarted = true
    state.preferences = turn.preferences
    if (turn.codebaseId) state.noCodebase = false
    else if (turn.noCodebase) state.noCodebase = true
    try {
      if (await this.hasCodebase(state, turn.actor)) return
      if (turn.codebaseId) {
        state.codebaseId = turn.codebaseId
        await setSessionRecordFolders(sessionId, { codebaseId: turn.codebaseId })
        return
      }
      if (state.noCodebase) return
      const projectFolder = projectFolderOf(turn)
      const existing = await codebaseOfProjectFolder(projectFolder, turn.actor)
      let taken: SessionCodebase | null = existing && { codebase: existing, formed: false }
      taken ??= await containerCodebaseOf(sessionId, projectFolder, turn.actor)
      for (const attached of attachedBefore) taken ??= await codebaseForAttachedFolder(sessionId, projectFolder, attached, turn.actor)
      if (taken) await this.takeCodebase(sessionId, state, taken, turn.actor)
    } catch (error) {
      log.warn('session_codebase_not_settled', { sessionId, error: error instanceof Error ? error.message : String(error) })
    }
  }

  /**
   * True when the session has a codebase. A session whose codebase a person
   * deleted is a session with no codebase. A codebase that this host has no
   * copy of yet is still the codebase of the session.
   */
  private async hasCodebase(state: SessionFoldersState, actor: Actor): Promise<boolean> {
    if (!state.codebaseId) return false
    const codebase = await getCodebase(recordScopeOf(actor.principal), state.codebaseId)
    return !codebase || codebase.deletedAt === null
  }

  /**
   * Give the session a codebase that a rule of decision 13 found or made, and
   * tell its clients. A codebase that the rule made is news of the thread: it
   * is recorded as an activity, as a move into a worktree is, so a reload and
   * each other client show its divider at the same place. `actor` is the
   * person that the turn or the attach acts for: that person is the creator
   * of the codebase, so the record names them.
   */
  private async takeCodebase(sessionId: string, state: SessionFoldersState, taken: SessionCodebase, actor: Actor): Promise<void> {
    const { codebase, formed } = taken
    state.codebaseId = codebase.id
    state.codebase = codebase
    await setSessionRecordFolders(sessionId, { codebaseId: codebase.id })
    if (formed) await this.rt.recordActivity({ kind: 'session', id: sessionId }, actor, formationActivity(codebase))
    this.rt.publish(sessionId, { type: 'session_codebase', codebaseId: codebase.id, name: codebase.name })
    log.info('session_codebase_taken', { sessionId, codebaseId: codebase.id, formed })
    if (taken.plainName) void this.nameFormed(sessionId, state, codebase, taken.plainName, actor)
  }

  /**
   * A codebase that a rule formed from separate projects has its plain name.
   * When the naming of the person (or of the project) is `generated`, a small
   * model call gives a short name, and the name replaces the plain one when
   * it arrives. The formation did not wait for it. A person who renamed the
   * codebase in that time keeps their name (`renameFormed`).
   */
  private async nameFormed(sessionId: string, state: SessionFoldersState, codebase: Codebase, plainName: string, actor: Actor): Promise<void> {
    try {
      const installationId = getInstallationId()
      const [projectRoot] = codebase.roots
      const preferences = state.preferences
      if (await resolveCodebaseNaming(projectRoot.path, preferences?.codebaseNaming) !== 'generated') return
      const folders = codebase.roots.map((root) => ({
        name: root.name || hostPathBaseName(root.path),
        path: root.installationId === installationId ? root.path : undefined,
      }))
      const generated = await generateCodebaseName(this.rt, folders, projectRoot.path, (provider) => this.rt.seatForTurn(actor, provider), preferences, organizationForNew(actor.principal))
      const renamed = generated ? await renameFormed(codebase.id, plainName, generated, actor) : null
      if (!renamed) return
      log.info('session_codebase_named', { sessionId, codebaseId: renamed.id })
      if (state.codebaseId !== renamed.id) return
      state.codebase = renamed
      this.rt.publish(sessionId, { type: 'session_codebase', codebaseId: renamed.id, name: renamed.name })
    } catch (error) {
      log.warn('session_codebase_not_named', { sessionId, codebaseId: codebase.id, error: error instanceof Error ? error.message : String(error) })
    }
  }

  /**
   * Rule 2 of decision 13: a folder was attached to a session with no
   * codebase. Before the first turn of the session in this process, the choice
   * of the person is not known, so the turn start reads the folder.
   */
  private async formForAttached(sessionId: string, state: SessionFoldersState, attached: SessionAttachedFolder, actor: Actor, name?: string): Promise<void> {
    if (!state.turnStarted) {
      state.attachedBeforeTurn.push(attached)
      return
    }
    try {
      if (state.noCodebase || !state.place || await this.hasCodebase(state, actor)) return
      const taken = await codebaseForAttachedFolder(sessionId, projectFolderOf(state.place), attached, actor, name)
      if (!taken) return
      await this.takeCodebase(sessionId, state, taken, actor)
      // The attached folder is a member now.
      await this.refresh(sessionId, state, actor)
    } catch (error) {
      log.warn('session_codebase_not_formed', { sessionId, path: attached.path, error: error instanceof Error ? error.message : String(error) })
    }
  }

  /**
   * The folders of a session for a reader. A session with a resolved list
   * answers it. A session with no live turn in this process is resolved from
   * its record.
   */
  async read(sessionId: string, actor: Actor): Promise<SessionFolder[]> {
    const state = await this.stateOf(sessionId)
    if (!state.entries) await this.refresh(sessionId, state, actor)
    return this.foldersOf(sessionId)
  }

  /** The resolved folders of a session, sorted by path. Empty before the first resolve. */
  foldersOf(sessionId: string): SessionFolder[] {
    return (this.sessions.get(sessionId)?.entries ?? []).map((entry) => entry.folder)
  }

  /**
   * The paths the provider may read and write besides the working directory:
   * for each granted folder, the named path and its real path, with no path
   * twice. A folder inside the working directory is not in the list: the
   * provider reaches it already.
   *
   * A worktree in a task folder keeps its Git data in its repository, so the
   * Git directory of that repository is in the list: without it, a provider
   * with a write sandbox cannot commit there. The files of the repository are
   * not granted.
   */
  grantedPaths(sessionId: string): string[] {
    const paths = new Set<string>()
    for (const { folder, realPath, reached } of this.sessions.get(sessionId)?.entries ?? []) {
      if (!folder.granted) continue
      if (folder.repositoryPath !== folder.path) paths.add(join(folder.repositoryPath, '.git'))
      if (reached) continue
      paths.add(folder.path)
      paths.add(realPath)
    }
    return [...paths]
  }

  /** The granted folder outside the working directory that holds `path`, or null. */
  grantedFolderOf(sessionId: string, path: string): string | null {
    const target = resolve(path)
    const holder = (this.sessions.get(sessionId)?.entries ?? []).find(({ folder, realPath, reached }) => {
      return folder.granted && !reached && (isInsideRoot(folder.path, target) || isInsideRoot(realPath, target))
    })
    return holder?.folder.path ?? null
  }

  /** The permission mode of the session: that of its live run, else the mode it last ran with. */
  modeOf(sessionId: string): PermissionMode | undefined {
    return this.rt.activeSessions.get(sessionId)?.runInput?.permissionMode ?? this.rt.sessionPermissionModes.get(sessionId)
  }

  /** The `git` folders of a session: each one gets its own checkpoint (stage 4). */
  checkpointTargets(sessionId: string): SessionFolder[] {
    return this.foldersOf(sessionId).filter((folder) => folder.state === 'git')
  }

  /** The codebase of a session: the live value, else the value of its record. */
  async codebaseIdOf(sessionId: string): Promise<string | null> {
    return (await this.stateOf(sessionId)).codebaseId
  }

  /**
   * The codebase that a turn of the session works with, before the turn
   * resolves its folders: the codebase the session has, else the one the
   * turn names.
   */
  async codebaseIdForTurn(sessionId: string, turnCodebaseId: string | null | undefined): Promise<string | null> {
    return (await this.stateOf(sessionId)).codebaseId ?? turnCodebaseId ?? null
  }

  /** What the session start writes to a record that does not exist yet (`persistIndexedSessionStart`). */
  recordFields(sessionId: string): SessionRecordFolders {
    const state = this.sessions.get(sessionId)
    const fields: SessionRecordFolders = {}
    if (state?.codebaseId) fields.codebaseId = state.codebaseId
    if (state?.attached.length) fields.attachedFolders = [...state.attached]
    return fields
  }

  /**
   * The data of the `<codebase>` prompt block: the working directory, the
   * granted folders on this host, and the roots of the codebase on other
   * hosts. Undefined when the session has one working directory and nothing
   * else: such a session gets no block.
   */
  promptFolders(sessionId: string): CodebaseBlock | undefined {
    const state = this.sessions.get(sessionId)
    if (!state?.place) return undefined
    const folders = (state.entries ?? []).filter((entry) => entry.folder.granted).map(({ folder }) => ({ name: folder.name, path: folder.path, state: folder.state }))
    const installationId = getInstallationId()
    const otherRoots = (state.codebase?.roots ?? []).filter((root) => root.installationId !== installationId)
    if (folders.length === 0 && otherRoots.length === 0) return undefined
    const hosts = otherRoots.length ? readHostList() : []
    const { workingDirectory } = state.place
    // The working directory of a task folder has the name of the member that it stands in for.
    const standsInFor = findTaskFolderContaining(workingDirectory)
    return {
      name: state.codebase?.name ?? null,
      workingDirectory: {
        name: basename(standsInFor && resolve(standsInFor.primaryPath) === resolve(workingDirectory) ? standsInFor.primaryRepositoryPath : workingDirectory),
        path: workingDirectory,
        state: this.rt.sessionCheckouts.getGitContext(sessionId) ? 'git' : 'plain',
      },
      folders,
      otherHosts: otherRoots.map((root) => ({
        name: root.name || hostPathBaseName(root.path),
        path: root.path,
        host: hosts.find((host) => host.installationId === root.installationId)?.label || root.installationId,
      })),
    }
  }

  /**
   * Attach a folder on this host to a session. The path must be a directory
   * that `actor` may use as a working directory. The working directory and a
   * path inside a session folder are refused: the session has them already.
   * The folder is in `foldersOf` when this returns, also in the middle of a turn.
   *
   * This function has no permission rule and no card. The rule of
   * docs/plans/codebases.md decision 8 goes in front of it. A folder in the
   * data of Solus is refused for each caller. A session with no codebase can
   * get one from the attach (decision 13, rule 2).
   *
   * `byName`: a person or the agent asked for this folder by its name. The
   * record keeps that, so the turn start does not take the folder away as a
   * folder that an automatic trigger left (`dropTemporaryFolders`).
   *
   * The attach card can decide the codebase of the attach (`AttachCodebase`):
   * `sessionOnly` makes none, and `codebaseName` is the name that the person
   * gave it.
   */
  async attach(sessionId: string, path: string, source: SessionFolderSource, actor: Actor, options: { byName?: boolean } & AttachCodebase = {}): Promise<SessionFolder[]> {
    const attached = await this.addFolder(sessionId, path, source, actor, options.byName)
    if (!options.sessionOnly) await this.formForAttached(sessionId, await this.stateOf(sessionId), attached, actor, options.codebaseName)
    return this.foldersOf(sessionId)
  }

  /**
   * `AttachSession.formationOf`: the codebase that an attach of `folder` forms
   * now, for the attach card, or null when it forms none: the session has a
   * codebase, the person chose "No codebase", or the folder is no real second
   * project (`formationFor`).
   */
  private async formationOf(state: SessionFoldersState, folder: string, source: SessionFolderSource, actor: Actor): Promise<{ name: string } | null> {
    if (state.noCodebase || !state.turnStarted || !state.place || await this.hasCodebase(state, actor)) return null
    const offer = await formationFor(projectFolderOf(state.place), { path: folder, source }, actor)
    return offer && { name: offer.name }
  }

  /** Add a folder to the session and its record. No rule, and no codebase is made. */
  private async addFolder(sessionId: string, path: string, source: SessionFolderSource, actor: Actor, byName = false): Promise<SessionAttachedFolder> {
    const folderPath = resolve(resolveHomePath(path))
    // The check a working directory passes: a guest stays in the checkout of the shared session.
    assertPathInScope('sessionAttachFolder', actor.principal, folderPath)
    const folderState = await folderStateOf(folderPath)
    if (folderState === 'missing') throw new Error(`"${folderPath}" is not a folder on this host.`)
    const state = await this.stateOf(sessionId)
    if (!state.entries) await this.refresh(sessionId, state, actor)
    const realPath = await realPathOf(folderPath)
    const refusal = await refusalForSolusData(folderPath, realPath)
    if (refusal) throw new Error(refusal)
    const workingDirectory = state.place ? await realPathOf(state.place.workingDirectory) : null
    if (workingDirectory === realPath) {
      throw new Error(`"${folderPath}" is the working directory of the session.`)
    }
    // A folder that Solus only shows (`observed`) can become a granted folder of the session.
    const isShownOnly = (entry: FolderEntry): boolean => entry.realPath === realPath && !entry.folder.granted
    const holder = (state.entries ?? []).find((entry) => isInsideRoot(entry.realPath, realPath) && !isShownOnly(entry))
    if (holder) throw new Error(`"${folderPath}" is already in the session folder "${holder.folder.path}".`)
    const attached: SessionAttachedFolder = byName ? { path: folderPath, source, byName } : { path: folderPath, source }
    state.attached = [...state.attached.filter((entry) => resolve(entry.path) !== folderPath), attached]
    const reached = workingDirectory !== null && isInsideRoot(workingDirectory, realPath)
    const entry: FolderEntry = { folder: attachedFolder(folderPath, folderState, source), realPath, reached }
    // The list changes before the record is written: a second attach of the folder at the same time finds it.
    this.setEntries(sessionId, state, [...(state.entries ?? []).filter((each) => !isShownOnly(each)), entry])
    await setSessionRecordFolders(sessionId, { attachedFolders: state.attached })
    log.info('session_folder_attached', { sessionId, path: folderPath, source, byName })
    return attached
  }

  /**
   * The attach rule (docs/plans/codebases.md decision 8) for a path of one
   * session: `session-folder-attach.ts` has the rule, and this owner gives it
   * the folders of the session. The session has the folder when the answer is
   * `attached` or `available`.
   */
  async requestAttach(sessionId: string, path: string, source: SessionFolderSource, actor: Actor, options: AttachRequestOptions = {}): Promise<AttachOutcome> {
    const state = await this.stateOf(sessionId)
    if (!state.place && options.workingDirectory) {
      state.place = this.storedPlaceOf(sessionId) ?? { workingDirectory: resolve(resolveHomePath(options.workingDirectory)), repositoryRoot: null }
    }
    if (!state.entries) await this.refresh(sessionId, state, actor)
    const modeOf = (id: string) => this.modeOf(id)
    const session: AttachSession = {
      sessionId,
      state,
      // Read when the rule asks: the mode of the session can change while the rule waits.
      get mode() { return modeOf(sessionId) },
      temporaryPlaces: this.temporaryPlaces,
      refresh: () => this.refresh(sessionId, state, actor),
      holderOf: (held) => this.holderOf(state, held),
      grantedHolderOf: (realPath) => (state.entries ?? []).find((entry) => entry.folder.granted && isInsideRoot(entry.realPath, realPath))?.folder.path ?? null,
      attach: async (folder, folderSource, codebase = {}) => { await this.attach(sessionId, folder, folderSource, actor, { byName: options.byName, ...codebase }) },
      formationOf: (folder, folderSource) => this.formationOf(state, folder, folderSource, actor),
      standInFor: (member) => this.standInFor(sessionId, state, member, actor),
    }
    return requestAttach(session, path, source, actor, options)
  }

  /** `SessionFolderGate`: the rule with no card, for a path that the provider was refused. */
  async attachUnasked(sessionId: string, path: string): Promise<string | null> {
    const actor = this.rt.actorOfSession(sessionId) ?? (await this.stateOf(sessionId)).actor
    if (!actor) return null
    const outcome = await this.requestAttach(sessionId, path, 'attached', actor)
    return outcome.kind === 'attached' || outcome.kind === 'available' ? outcome.folder : null
  }

  /** `SessionFolderGate`: a person allowed a request that names `paths` for the session, so the folder of each one is attached with no card. */
  attachAllowed(sessionId: string, paths: readonly string[]): void {
    void this.attachFoldersOf(sessionId, paths, 'attached')
  }

  /**
   * A project tool made `path` in this session (decision 11), and the session
   * works there with no card: the tool call was approved.
   *
   * - A folder in the project folder: it is a part of that project, or, in a
   *   container, a member that the read of the disk finds. It needs no
   *   codebase and no root.
   * - A folder outside it, in a session with a codebase: a root of that
   *   codebase on this host, unless `addToCodebase` is false or a root holds it.
   * - A folder outside it, in a session with no codebase: the agent made a
   *   real second project, so the attach makes the codebase of the two
   *   folders (decision 13, rule 2), unless `addToCodebase` is false.
   */
  async adoptCreated(sessionId: string, path: string, addToCodebase: boolean, actor: Actor): Promise<{ addedToCodebase: boolean }> {
    const state = await this.stateOf(sessionId)
    if (!state.entries) await this.refresh(sessionId, state, actor)
    const folder = resolve(resolveHomePath(path))
    const realPath = await realPathOf(folder)
    if (state.place && isInsideRoot(await realPathOf(projectFolderOf(state.place)), realPath)) {
      // The read of the disk finds a new repository of a container. A place that the session does not reach after it is attached.
      await this.refresh(sessionId, state, actor)
      if (!await this.holderOf(state, folder)) await this.addFolder(sessionId, folder, 'created', actor)
      return { addedToCodebase: false }
    }
    const addedToCodebase = addToCodebase && await addCodebaseRoot(sessionId, state, folder, actor)
    if ((state.entries ?? []).some((entry) => entry.folder.granted && isInsideRoot(entry.realPath, realPath))) {
      // A session folder holds the new folder. In a codebase, a new repository there is a member: read the disk again.
      if (state.codebase) await this.refresh(sessionId, state, actor)
      return { addedToCodebase }
    }
    // A caller that keeps the folder out of the codebase also makes no codebase with it.
    if (!addToCodebase) {
      await this.addFolder(sessionId, folder, 'created', actor)
      return { addedToCodebase }
    }
    await this.attach(sessionId, folder, 'created', actor)
    const installationId = getInstallationId()
    const isRoot = state.codebase?.roots.some((root) => root.installationId === installationId && sameHostPath(root.path, folder)) ?? false
    return { addedToCodebase: addedToCodebase || isRoot }
  }

  /** Read one event of a session: the turn end attaches the folders that its tools wrote (`attachObserved`). */
  observe(sessionId: string, event: NormalizedEvent): void {
    this.writes.observe(sessionId, event)
  }

  /**
   * At a turn end: each repository that a tool of the turn changed a file in,
   * and that is not a folder of the session, becomes a folder that Solus only
   * shows (`observed`, not granted). No mode asks for it: the write happened.
   * A folder with no repository is left out, because it has no diff to review.
   */
  async attachObserved(sessionId: string): Promise<void> {
    await this.attachFoldersOf(sessionId, this.writes.take(sessionId), 'observed')
  }

  /** One path after the other: two files of one repository give one folder. A path that cannot be attached stops nothing. */
  private async attachFoldersOf(sessionId: string, paths: readonly string[], source: 'attached' | 'observed'): Promise<void> {
    for (const path of paths) {
      try {
        await this.attachFolderOf(sessionId, path, source)
      } catch (error) {
        log.warn('session_folder_attach_failed', { sessionId, path, source, error: error instanceof Error ? error.message : String(error) })
      }
    }
  }

  /**
   * Attach the folder that `path` names, with no card, when the session does
   * not have it. This is an automatic trigger: nobody asked for the folder by
   * its name, so only a Git repository or a project that the host lists is
   * attached (`automaticAttachTarget`). A session that no turn started in this
   * process has no person to act for, and gets nothing.
   */
  private async attachFolderOf(sessionId: string, path: string, source: 'attached' | 'observed'): Promise<void> {
    const state = await this.stateOf(sessionId)
    const actor = this.rt.actorOfSession(sessionId) ?? state.actor
    if (!actor) return
    if (!state.entries) await this.refresh(sessionId, state, actor)
    const isObserved = source === 'observed'
    const named = resolve(resolveHomePath(path))
    if (await this.holderOf(state, named, isObserved)) return
    const target = await attachTargetOf(named)
    if ('refused' in target || await this.holderOf(state, target.folder, isObserved)) return
    const automatic = await automaticAttachTarget(target.folder, this.temporaryPlaces)
    if ('refused' in automatic || await this.holderOf(state, automatic.folder, isObserved)) return
    if (isObserved && await folderStateOf(automatic.folder) !== 'git') return
    await this.attach(sessionId, automatic.folder, source, actor)
  }

  /**
   * What holds `path` in the session already: the working directory, or a
   * granted folder. `orShown` also counts a folder that Solus only shows.
   */
  private async holderOf(state: SessionFoldersState, path: string, orShown = false): Promise<string | null> {
    const realPath = await realPathOf(path)
    if (state.place && isInsideRoot(await realPathOf(state.place.workingDirectory), realPath)) return state.place.workingDirectory
    const holder = (state.entries ?? []).find((entry) => (orShown || entry.folder.granted) && isInsideRoot(entry.realPath, realPath))
    return holder?.folder.path ?? null
  }

  /**
   * Remove an attached folder from a session. A folder that comes from the
   * codebase of the session stays: a person removes it from the codebase.
   */
  async detach(sessionId: string, path: string, actor: Actor): Promise<SessionFolder[]> {
    const folderPath = resolve(resolveHomePath(path))
    const state = await this.stateOf(sessionId)
    if (!state.entries) await this.refresh(sessionId, state, actor)
    const entry = (state.entries ?? []).find((each) => each.folder.path === folderPath)
    if (entry?.folder.source === 'codebase') {
      throw new Error(`"${folderPath}" comes from the codebase of the session. Remove it from the codebase.`)
    }
    const attached = state.attached.filter((each) => resolve(each.path) !== folderPath)
    if (attached.length === state.attached.length) return this.foldersOf(sessionId)
    state.attached = attached
    await setSessionRecordFolders(sessionId, { attachedFolders: attached })
    this.setEntries(sessionId, state, (state.entries ?? []).filter((each) => each !== entry))
    log.info('session_folder_detached', { sessionId, path: folderPath })
    return this.foldersOf(sessionId)
  }

  /**
   * Read the codebase and the disk of a session again, now, and answer the new
   * list: a repository got its worktree in the task folder of the session.
   */
  async reread(sessionId: string, actor: Actor): Promise<SessionFolder[]> {
    await this.refresh(sessionId, await this.stateOf(sessionId), actor)
    return this.foldersOf(sessionId)
  }

  /**
   * `AttachSession.standInFor`: in a task folder session, a repository of the
   * codebase is reached only through its worktree, so the session stays
   * isolated. A repository that has its worktree is available there. One that
   * has none gets it now. Null for a session with no task folder, and for a
   * plain folder, which has no worktree.
   */
  private async standInFor(sessionId: string, state: SessionFoldersState, member: string, actor: Actor): Promise<AttachOutcome | null> {
    const taskFolder = taskFolderOf(state)
    if (!taskFolder || await folderStateOf(member) !== 'git') return null
    const known = await worktreeOfMember(taskFolder, await realPathOf(member))
    if (known) return { kind: 'available', folder: known }
    try {
      await this.rt.taskFolders.addRepository(sessionId, member, actor)
      const after = taskFolderOf(state)
      const made = after ? await worktreeOfMember(after, await realPathOf(member)) : null
      return made ? { kind: 'attached', folder: made, addedToCodebase: false } : { kind: 'invalid', message: `${member} got no worktree in the task folder of the session.` }
    } catch (error) {
      return { kind: 'invalid', message: error instanceof Error ? error.message : String(error) }
    }
  }

  /**
   * Give one client the folders and the codebase of a session it starts to
   * watch. The folders go now, before a `git_context` names one of them. The
   * codebase goes after a read of its record: the copy of this session is as
   * old as its last turn start, and a person can delete the codebase after
   * that. A deleted codebase is not sent, so the client has none for the session.
   */
  replayTo(sessionId: string, clientId: string): void {
    const folders = this.foldersOf(sessionId)
    if (folders.length) this.rt.publish(sessionId, { type: 'session_folders', folders }, { only: clientId })
    const codebaseId = this.sessions.get(sessionId)?.codebase?.id
    if (codebaseId) void this.replayCodebase(sessionId, codebaseId, clientId)
  }

  private async replayCodebase(sessionId: string, codebaseId: string, clientId: string): Promise<void> {
    try {
      // The session has this codebase already. The read asks only if its record is deleted now.
      const codebase = await getCodebase(ANY_ORGANIZATION, codebaseId)
      if (!codebase || codebase.deletedAt !== null) return
      this.rt.publish(sessionId, { type: 'session_codebase', codebaseId: codebase.id, name: codebase.name }, { only: clientId })
    } catch (error) {
      log.warn('session_codebase_replay_failed', { sessionId, codebaseId, error: error instanceof Error ? error.message : String(error) })
    }
  }

  /**
   * A folder became something different on the disk: "Track with Git" made a
   * plain folder a repository. Each session that has the folder reads its
   * folders again, so the folder's state is `git` and its checkout is watched.
   * `actor` reads for a session that no turn started in this process.
   */
  async folderChanged(path: string, actor: Actor): Promise<void> {
    const folderPath = resolve(resolveHomePath(path))
    for (const [sessionId, state] of this.sessions) {
      if (!state.entries?.some((entry) => entry.folder.path === folderPath)) continue
      await this.refresh(sessionId, state, this.rt.actorOfSession(sessionId) ?? state.actor ?? actor)
    }
  }

  /** The `git` folders of each session whose folders this process resolved (stage 4: the branch of each can have a pull request). */
  gitFolders(): { sessionId: string; folder: SessionFolder }[] {
    return [...this.sessions.keys()].flatMap((sessionId) => this.checkpointTargets(sessionId).map((folder) => ({ sessionId, folder })))
  }

  /** The state of a session, read from its record the first time this process asks. */
  private async stateOf(sessionId: string): Promise<SessionFoldersState> {
    const known = this.sessions.get(sessionId)
    if (known) return known
    const stored = await storedSessionFolders(sessionId)
    const raced = this.sessions.get(sessionId)
    if (raced) return raced
    const state: SessionFoldersState = {
      codebaseId: stored?.codebaseId ?? null,
      attached: stored?.attachedFolders ?? [],
      codebase: null,
      entries: null,
      place: null,
      watched: new Set(),
      published: '[]',
      openCards: new Map(),
      refused: new Set(),
      actor: null,
      noCodebase: false,
      turnStarted: false,
      attachedBeforeTurn: [],
      preferences: undefined,
    }
    this.sessions.set(sessionId, state)
    return state
  }

  /** Where a session with no turn in this process works: its live run, else its lineage, else its index row. */
  private storedPlaceOf(sessionId: string): SessionWorkingPlace | null {
    const git = this.rt.sessionCheckouts.getGitContext(sessionId)
    const workingDirectory = this.rt.sessionCheckouts.sessionCheckoutPaths.get(sessionId)
      ?? this.rt.activeSessions.get(sessionId)?.runInput?.workingDirectory
      ?? resolveSessionLineageById(sessionId)?.active.cwd
      ?? getIndexedSession(sessionId)?.cwd
    if (!workingDirectory) return null
    return { workingDirectory: resolveHomePath(workingDirectory), repositoryRoot: git?.repoRoot ?? getIndexedSession(sessionId)?.projectRoot ?? null }
  }

  /** Read the codebase and the disk again, and keep the new list. */
  private async refresh(sessionId: string, state: SessionFoldersState, actor: Actor): Promise<void> {
    state.place ??= this.storedPlaceOf(sessionId)
    const codebase = state.codebaseId ? await getCodebase(recordScopeOf(actor.principal), state.codebaseId) : null
    state.codebase = codebase && codebase.deletedAt === null ? codebase : null
    const members = state.codebase ? await membersOf(state.codebase, getInstallationId()) : []

    const workingDirectory = state.place ? await realPathOf(state.place.workingDirectory) : null
    const repositoryRoot = state.place?.repositoryRoot ? await realPathOf(state.place.repositoryRoot) : null
    const isReached = (realPath: string): boolean => workingDirectory !== null && isInsideRoot(workingDirectory, realPath)
    const standIns = await taskFolderStandIns(taskFolderOf(state), members)
    const entries = new Map<string, FolderEntry>()
    for (const member of members) {
      if (member.state === 'missing') continue
      const worktreePath = await standIns(member)
      if (worktreePath === NOT_A_FOLDER) continue
      const folder = folderOfMember(member, member.state, worktreePath)
      const realPath = await realPathOf(folder.path)
      // The working directory is not a folder besides itself, and it stands in for the repository it is in.
      if (realPath === workingDirectory || realPath === repositoryRoot) continue
      if (!entries.has(realPath)) entries.set(realPath, { folder, realPath, reached: isReached(realPath) })
    }
    for (const attached of state.attached) {
      const path = resolve(attached.path)
      const folderState = await folderStateOf(path)
      // A folder that is gone is not a session folder now. The record keeps it: it can come back.
      if (folderState === 'missing') continue
      const realPath = await realPathOf(path)
      if (realPath === workingDirectory || entries.has(realPath)) continue
      entries.set(realPath, { folder: attachedFolder(path, folderState, attached.source), realPath, reached: isReached(realPath) })
    }
    this.setEntries(sessionId, state, await outsideSolusData([...entries.values()]))
  }

  /** Keep a new list: publish it when it changed, and hear the checkout of each `git` folder in it. */
  private setEntries(sessionId: string, state: SessionFoldersState, entries: FolderEntry[]): void {
    state.entries = entries.sort(byPath)
    const folders = state.entries.map((entry) => entry.folder)
    const serialized = JSON.stringify(folders)
    if (serialized !== state.published) {
      state.published = serialized
      this.rt.publish(sessionId, { type: 'session_folders', folders })
    }
    const gitPaths = new Set(folders.filter((folder) => folder.state === 'git').map((folder) => folder.path))
    for (const path of state.watched) if (!gitPaths.has(path)) state.watched.delete(path)
    for (const path of gitPaths) {
      if (state.watched.has(path)) continue
      state.watched.add(path)
      // A checkout the service knows already causes no change event: tell this session now.
      const known = this.rt.checkouts.get(path)?.checkout
      if (known) this.rt.publish(sessionId, { type: 'git_context', cwd: path, gitContext: known })
      // The read registers the folder with the checkout service, which then watches it.
      void this.rt.checkouts.refresh(path).catch((error) => log.warn('session_folder_refresh_failed', { sessionId, cwd: path, error: String(error) }))
    }
  }
}

/**
 * The entries that are not in the data of Solus (docs/plans/codebases.md
 * decision 8). A person can write each path as a root of a codebase, and an
 * old session record can name each folder: such a folder is still not a
 * folder of a session.
 */
async function outsideSolusData(entries: FolderEntry[]): Promise<FolderEntry[]> {
  const kept: FolderEntry[] = []
  for (const entry of entries) {
    if (!await refusalForSolusData(entry.folder.path, entry.realPath)) kept.push(entry)
  }
  return kept
}

/** The task folder that the session works in, or null. Its record is read at each call: a repository can get its worktree in the middle of a turn. */
function taskFolderOf(state: SessionFoldersState): TaskFolder | null {
  return state.place ? findTaskFolderContaining(state.place.workingDirectory) : null
}

/**
 * The session folder that stands for a member of the codebase. This is the one place that chooses where a session works for a
 * member: the member itself, or, in a task folder session, the worktree of
 * the member (docs/plans/codebases.md §7). `repositoryPath` is the member in
 * each case, so a folder whose `path` is not its `repositoryPath` is an
 * isolated worktree. A plain member has no worktree: a task folder session
 * works in the original.
 */
function folderOfMember(member: CodebaseMember, state: SessionFolder['state'], worktreePath: string | null): SessionFolder {
  const repositoryPath = resolve(member.path)
  return { path: worktreePath ?? repositoryPath, name: member.name, state, repositoryPath, source: 'codebase', granted: true }
}

function attachedFolder(path: string, state: SessionFolder['state'], source: SessionFolderSource): SessionFolder {
  // An observed folder is only shown: the provider was not granted it.
  return { path, name: basename(path), state, repositoryPath: path, source, granted: source !== 'observed' }
}
