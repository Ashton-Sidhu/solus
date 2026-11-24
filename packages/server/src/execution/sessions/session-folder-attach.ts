import { stat } from 'node:fs/promises'
import { resolve } from 'node:path'
import type { Codebase, SessionFolderSource } from '@solus/contracts/codebases'
import { isInsideHostPath } from '@solus/contracts/host-path'
import type { NormalizedEvent, PermissionMode } from '@solus/contracts/types'
import { ownerKeyOf, type Actor } from '../../admission/actor'
import { getInstallationId } from '../../admission/auth'
import { organizationForNew, recordScopeOf } from '../../admission/principal'
import { getCodebase, saveCodebase } from '../../data/codebases/codebases'
import { membersOf } from '../../files/codebase-members'
import { readHostList } from '../../host/host-list'
import { hostUserKey } from '../../host/host-user'
import { createLogger } from '../../logger'
import { resolveHomePath } from '../../platform/paths'
import { attachTargetOf, realPathOf } from './attach-target'
import { answerToolQuestionWith } from './input-requests'

const log = createLogger('SessionRuntime', 'session-folder-attach.ts')

/** What `requestAttach` did for a path. */
export type AttachOutcome =
  /** `folder` is a session folder now. It can be the repository root above the path, or the worktree of that repository in the task folder of the session. */
  | { kind: 'attached'; folder: string; addedToCodebase: boolean }
  /** The working directory or a session folder (`folder`) holds the path already. */
  | { kind: 'available'; folder: string }
  /** The path is in a root of the session's codebase on a different host, and it is not on this host. */
  | { kind: 'other-host'; host: string; path: string }
  /** The person refused the folder on its card, in this turn. */
  | { kind: 'refused'; folder: string }
  /** The folder needs a card, and the caller gave no way to show one, or the turn stopped before the answer. */
  | { kind: 'not-asked'; folder: string }
  /** No folder can be attached for the path. `message` says why. */
  | { kind: 'invalid'; message: string }

/** How `requestAttach` shows its card: the event channel of the turn, and the signal that stops the turn. */
export interface AttachAsker {
  emit(event: NormalizedEvent): void
  signal: AbortSignal
}

export interface AttachRequestOptions {
  /** Without it, a folder that needs a card is not attached (`not-asked`). */
  asker?: AttachAsker
  /** The mode of a turn that has not started. Default: the mode of the session. */
  mode?: PermissionMode
  /** Where a session will work when no turn of it has started. */
  workingDirectory?: string
}

/** The question of the attach card, and the labels of its choices. A choice is answered by its label. */
export const ATTACH_QUESTION_ID = 'attach-folder'
export const ATTACH_QUESTION_ID_PREFIX = 'attach-folder-'
export const ATTACH_CHOICE = {
  session: 'Allow for this session',
  codebase: 'Allow and add to the codebase',
  refuse: 'Do not allow',
} as const

/** What the attach rule keeps for one session. `SessionFolders` owns the object. */
export interface AttachState {
  codebaseId: string | null
  /** The record of the codebase as last read. Null for no codebase, and for a deleted one. */
  codebase: Codebase | null
  /** The attach cards that wait for an answer, by folder: a second request for a folder waits for the same answer. */
  openCards: Map<string, Promise<AttachOutcome>>
  /** The folders that the person refused in this turn. They are not asked again before the next turn. */
  refused: Set<string>
}

/** The folders of one session, as the attach rule reads and changes them. `SessionFolders` gives it. */
export interface AttachSession {
  sessionId: string
  state: AttachState
  mode: PermissionMode | undefined
  /** Read the codebase and the disk again. */
  refresh(): Promise<void>
  /** What holds `path` in the session already: the working directory or a granted folder. */
  holderOf(path: string): Promise<string | null>
  /** The granted folder that holds the real path `realPath`, read with no wait. */
  grantedHolderOf(realPath: string): string | null
  /** Add the folder with no rule (`SessionFolders.attach`). */
  attach(folder: string, source: SessionFolderSource): Promise<void>
  /**
   * In a task folder session: the outcome for a repository of the codebase,
   * whose worktree stands in for it. Null when the rule goes on.
   */
  standInFor(member: string): Promise<AttachOutcome | null>
}

/**
 * The attach rule (docs/plans/codebases.md decision 8). `path` names the
 * folder to attach (`attachTargetOf`). The session has the folder when the
 * answer is `attached` or `available`.
 *
 * - A path in the working directory or in a session folder is available.
 * - A member of the session's codebase on this host is attached in each mode.
 *   In a task folder session, the worktree of a repository stands in for it.
 * - A path in a root of the codebase on a different host, which is not on
 *   this host, is not attached: the answer names the host.
 * - Modes `full-access` and `auto` attach with no card.
 * - The other modes show one card for the folder. A second request for the
 *   same folder waits for the same answer, and a refused folder is not asked
 *   again in the turn.
 */
export async function requestAttach(session: AttachSession, path: string, source: SessionFolderSource, actor: Actor, options: AttachRequestOptions = {}): Promise<AttachOutcome> {
  const { state } = session
  const named = resolve(resolveHomePath(path.trim()))
  const otherHost = await rootOnOtherHost(state, named)
  if (otherHost) return otherHost
  const holder = await session.holderOf(named)
  if (holder) return { kind: 'available', folder: holder }
  const target = await attachTargetOf(named)
  if ('refused' in target) return { kind: 'invalid', message: target.refused }
  const { folder } = target

  if (state.codebase && await isMember(state.codebase, folder)) {
    const standIn = await session.standInFor(folder)
    if (standIn) return standIn
    // The disk changed after the turn start: the read of the members gives the folder.
    await session.refresh()
    if (await session.holderOf(folder)) return { kind: 'attached', folder, addedToCodebase: false }
    return attachNow(session, folder, source, actor, false)
  }
  const mode = options.mode ?? session.mode
  if (mode === 'full-access' || mode === 'auto') return attachNow(session, folder, source, actor, false)
  const realFolder = await realPathOf(folder)
  // From here to the card there is no wait: a request for the folder that finished, or that opened its card, is seen.
  const attached = session.grantedHolderOf(realFolder)
  if (attached) return { kind: 'available', folder: attached }
  if (state.refused.has(folder)) return { kind: 'refused', folder }
  const open = state.openCards.get(folder)
  if (open) return open
  const { asker } = options
  if (!asker) return { kind: 'not-asked', folder }
  const card = askToAttach(session, folder, source, actor, asker).finally(() => state.openCards.delete(folder))
  state.openCards.set(folder, card)
  return card
}

/** The answer for a path that is in a root of the codebase on a different host and is not on this host. */
async function rootOnOtherHost(state: AttachState, path: string): Promise<AttachOutcome | null> {
  const installationId = getInstallationId()
  const root = state.codebase?.roots.find((each) => each.installationId !== installationId && isInsideHostPath(each.path, path))
  if (!root || await stat(path).catch(() => null)) return null
  const host = readHostList().find((each) => each.installationId === root.installationId)?.label || root.installationId
  return { kind: 'other-host', host, path }
}

async function isMember(codebase: Codebase, folder: string): Promise<boolean> {
  const realPath = await realPathOf(folder)
  for (const member of await membersOf(codebase, getInstallationId())) {
    if (member.state !== 'missing' && await realPathOf(member.path) === realPath) return true
  }
  return false
}

async function attachNow(session: AttachSession, folder: string, source: SessionFolderSource, actor: Actor, addToCodebase: boolean): Promise<AttachOutcome> {
  try {
    await session.attach(folder, source)
  } catch (error) {
    // A request for the same folder at the same time attached it first.
    const holder = await session.holderOf(folder)
    if (holder) return { kind: 'available', folder: holder }
    return { kind: 'invalid', message: error instanceof Error ? error.message : String(error) }
  }
  return { kind: 'attached', folder, addedToCodebase: addToCodebase && await addCodebaseRoot(session.sessionId, session.state, folder, actor) }
}

/** Show the attach card of one folder, and do what the person chose. */
async function askToAttach(session: AttachSession, folder: string, source: SessionFolderSource, actor: Actor, asker: AttachAsker): Promise<AttachOutcome> {
  const { sessionId, state } = session
  const questionId = `${ATTACH_QUESTION_ID_PREFIX}${crypto.randomUUID()}`
  const options = [
    { label: ATTACH_CHOICE.session, description: 'The agent can read and change this folder in this session.' },
    ...(state.codebase ? [{ label: ATTACH_CHOICE.codebase, description: `Also add the folder to the codebase "${state.codebase.name}".` }] : []),
    { label: ATTACH_CHOICE.refuse, description: 'The agent does not get this folder.' },
  ]
  // Null: the turn stopped before the person answered.
  const choice = await new Promise<string | null>((answer) => {
    const stopped = (): void => { stop(); answer(null) }
    const stop = answerToolQuestionWith(questionId, (answers) => {
      asker.signal.removeEventListener('abort', stopped)
      answer(answers[ATTACH_QUESTION_ID] ?? '')
    })
    if (asker.signal.aborted) { stopped(); return }
    asker.signal.addEventListener('abort', stopped, { once: true })
    asker.emit({
      type: 'question_request',
      questionId,
      questions: [{ id: ATTACH_QUESTION_ID, header: 'Attach folder', question: `The agent wants to work in the folder "${folder}". Allow it?`, options, multiSelect: false }],
    })
  })
  log.info('session_folder_card_answered', { sessionId, path: folder, choice })
  if (choice === null) return { kind: 'not-asked', folder }
  if (choice === ATTACH_CHOICE.session) return attachNow(session, folder, source, actor, false)
  if (choice === ATTACH_CHOICE.codebase && state.codebase) return attachNow(session, folder, source, actor, true)
  state.refused.add(folder)
  return { kind: 'refused', folder }
}

/**
 * Add `folder` as a root of the session's codebase on this host. The copy
 * gets a newer `updatedAt`, so each host takes it. False when the session
 * has no codebase, when a root on this host holds the folder already, and
 * when the person may not save the codebase.
 */
export async function addCodebaseRoot(sessionId: string, state: AttachState, folder: string, actor: Actor): Promise<boolean> {
  if (!state.codebaseId) return false
  const installationId = getInstallationId()
  try {
    const codebase = await getCodebase(recordScopeOf(actor.principal), state.codebaseId)
    if (!codebase || codebase.deletedAt !== null) return false
    if (codebase.roots.some((root) => root.installationId === installationId && isInsideHostPath(root.path, folder))) return false
    state.codebase = await saveCodebase(organizationForNew(actor.principal), ownerKeyOf(actor) ?? hostUserKey(), {
      ...codebase,
      roots: [...codebase.roots, { installationId, path: folder, name: '' }],
      updatedAt: Math.max(Date.now(), codebase.updatedAt + 1),
    })
    log.info('session_codebase_root_added', { sessionId, codebaseId: codebase.id, path: folder })
    return true
  } catch (error) {
    log.warn('session_codebase_root_failed', { sessionId, path: folder, error: error instanceof Error ? error.message : String(error) })
    return false
  }
}
