import { stat } from 'node:fs/promises'
import { resolve } from 'node:path'
import { nextUpdatedAt } from '@solus/client-core/codebases'
import type { Codebase, SessionFolderSource } from '@solus/contracts/codebases'
import { isInsideHostPath } from '@solus/contracts/host-path'
import type { NormalizedEvent, PermissionMode } from '@solus/contracts/types'
import type { Actor } from '../../admission/actor'
import { getInstallationId } from '../../admission/auth'
import { codebasesFor } from '../../data/codebases/codebases'
import { membersOf } from '../../files/codebase-members'
import { readHostList } from '../../host/host-list'
import { createLogger } from '../../logger'
import { realPathOf } from '../../paths'
import { resolveHomePath } from '../../platform/paths'
import { attachTargetOf, automaticAttachTarget } from './attach-target'
import { answerToolQuestionWith } from './input-requests'
import { rootOf } from './session-codebase-formation'

const log = createLogger('SessionRuntime', 'session-folder-attach.ts')

/** The longest name that the card takes for a codebase: the limit of the record. */
const CODEBASE_NAME_MAX = 200

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
  /**
   * The agent asked for this folder by its name (the `attach_folder` tool).
   * Without it, the request is an automatic trigger, which attaches only a
   * Git repository or a project that the host lists (`automaticAttachTarget`).
   */
  byName?: boolean
}

/** The question of the attach card, and the labels of its choices. A choice is answered by its label. */
export const ATTACH_QUESTION_ID = 'attach-folder'
export const ATTACH_QUESTION_ID_PREFIX = 'attach-folder-'
export const ATTACH_CHOICE = {
  session: 'Allow for this session',
  codebase: 'Allow and add to the codebase',
  /** Only when the attach forms a codebase: the two choices below take the place of `session`. */
  make: 'Allow and make the codebase',
  sessionOnly: 'Allow for this session only',
  refuse: 'Do not allow',
} as const

/** What the attach card decided about the codebase that an attach forms. */
export interface AttachCodebase {
  /** The person allowed the folder for this session only: the attach forms no codebase. */
  sessionOnly?: boolean
  /** The name that the person typed for the codebase. Without it, the codebase gets its plain name. */
  codebaseName?: string
}

/** What a person answered on the attach card. */
export interface AttachAnswer {
  /** The label of the choice. Null for an answer that starts with no choice of the card. */
  choice: string | null
  /** The words that the person typed in the answer field. Empty when they typed none. */
  typed: string
}

/**
 * The answer of the attach card: the choice, and the words that the person
 * typed in the answer field of the card. A client sends the two as one text,
 * the label, then ` — `, then the words (`formatAnswer`). An answer that
 * starts with no choice is no choice.
 */
export function attachAnswerOf(answer: string): AttachAnswer {
  const labels = Object.values(ATTACH_CHOICE).sort((a, b) => b.length - a.length)
  for (const label of labels) {
    if (answer === label) return { choice: label, typed: '' }
    if (answer.startsWith(`${label} — `)) return { choice: label, typed: answer.slice(label.length + 3).trim() }
  }
  return { choice: null, typed: '' }
}

/** What the attach rule keeps for one session. `SessionFolders` owns the object. */
export interface AttachState {
  readonly sessionId: string
  codebaseId: string | null
  /** The record of the codebase as last read. Null for no codebase, and for a deleted one. */
  codebase: Codebase | null
  /** The attach cards that wait for an answer, by folder: a second request for a folder waits for the same answer. */
  openCards: Map<string, Promise<AttachOutcome>>
  /** The folders that the person refused in this turn. They are not asked again before the next turn. */
  refused: Set<string>
}

/**
 * One request of the attach rule: the folders of one session, as the rule
 * reads and changes them, the person that the request acts for, and how the
 * folder is attached. `SessionFolders` gives it.
 */
export interface AttachRequest {
  state: AttachState
  actor: Actor
  source: SessionFolderSource
  mode: PermissionMode | undefined
  /** The temporary directories of the system, which an automatic trigger does not attach. */
  temporaryPlaces: readonly string[]
  /** Read the codebase and the disk again. */
  refresh(): Promise<void>
  /** What holds `path` in the session already: the working directory or a granted folder. */
  holderOf(path: string): Promise<string | null>
  /** The granted folder that holds the real path `realPath`, read with no wait. */
  grantedHolderOf(realPath: string): string | null
  /** Add the folder with no rule (`SessionFolders.attach`). `codebase` is the decision of the card about the codebase that the attach forms. */
  attach(folder: string, codebase?: AttachCodebase): Promise<void>
  /**
   * The codebase that an attach of `folder` forms now (decision 13, rule 2),
   * with its proposed name, or null when the attach forms none.
   */
  formationOf(folder: string): Promise<{ name: string } | null>
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
 * - A folder in the data of Solus is not attached (`attachTargetOf`).
 * - A request that is an automatic trigger attaches only a Git repository or
 *   a project that the host lists, never a temporary directory of the system
 *   or a folder that cannot be read, in each mode (`automaticAttachTarget`).
 *   A member of the codebase is not such a request: a person put it in the
 *   codebase.
 * - Modes `full-access` and `auto` attach with no card.
 * - The other modes show one card for the folder. A second request for the
 *   same folder waits for the same answer, and a refused folder is not asked
 *   again in the turn. When the attach forms a codebase (the session has
 *   none, and the folder is a real second project), the card says so, and
 *   the person can change the name of the codebase before it is made.
 */
export async function requestAttach(request: AttachRequest, path: string, options: AttachRequestOptions = {}): Promise<AttachOutcome> {
  const { state } = request
  const named = resolve(resolveHomePath(path.trim()))
  const otherHost = await rootOnOtherHost(state, named)
  if (otherHost) return otherHost
  const holder = await request.holderOf(named)
  if (holder) return { kind: 'available', folder: holder }
  const target = await attachTargetOf(named)
  if ('refused' in target) return { kind: 'invalid', message: target.refused }
  let { folder } = target

  if (state.codebase && await isMember(state.codebase, folder)) {
    const standIn = await request.standInFor(folder)
    if (standIn) return standIn
    // The disk changed after the turn start: the read of the members gives the folder.
    await request.refresh()
    if (await request.holderOf(folder)) return { kind: 'attached', folder, addedToCodebase: false }
    return attachNow(request, folder, false)
  }
  if (!options.byName) {
    const automatic = await automaticAttachTarget(folder, request.temporaryPlaces)
    if ('refused' in automatic) return { kind: 'invalid', message: automatic.refused }
    // The project that the host lists is the folder of the work, not the folder of the path inside it.
    folder = automatic.folder
  }
  const mode = options.mode ?? request.mode
  if (mode === 'full-access' || mode === 'auto') return attachNow(request, folder, false)
  const realFolder = await realPathOf(folder)
  // From here to the card there is no wait: a request for the folder that finished, or that opened its card, is seen.
  const attached = request.grantedHolderOf(realFolder)
  if (attached) return { kind: 'available', folder: attached }
  if (state.refused.has(folder)) return { kind: 'refused', folder }
  const open = state.openCards.get(folder)
  if (open) return open
  const { asker } = options
  if (!asker) return { kind: 'not-asked', folder }
  const card = askToAttach(request, folder, asker).finally(() => state.openCards.delete(folder))
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

async function attachNow(request: AttachRequest, folder: string, addToCodebase: boolean, codebase?: AttachCodebase): Promise<AttachOutcome> {
  try {
    await request.attach(folder, codebase)
  } catch (error) {
    // A request for the same folder at the same time attached it first.
    const holder = await request.holderOf(folder)
    if (holder) return { kind: 'available', folder: holder }
    return { kind: 'invalid', message: error instanceof Error ? error.message : String(error) }
  }
  return { kind: 'attached', folder, addedToCodebase: addToCodebase && await addCodebaseRoot(request.state, folder, request.actor) }
}

/** Show the attach card of one folder, and do what the person chose. */
async function askToAttach(request: AttachRequest, folder: string, asker: AttachAsker): Promise<AttachOutcome> {
  const { state } = request
  const { sessionId } = state
  const questionId = `${ATTACH_QUESTION_ID_PREFIX}${crypto.randomUUID()}`
  // The attach forms a codebase: the card says so, and the person can name it.
  const formation = state.codebase ? null : await request.formationOf(folder)
  const question = formation
    ? `The agent wants to work in the folder "${folder}". Solus then makes the codebase "${formation.name}" from this folder and the project of the session. Allow it?`
    : `The agent wants to work in the folder "${folder}". Allow it?`
  const options = formation
    ? [
        { label: ATTACH_CHOICE.make, description: `The codebase gets the name "${formation.name}". To change the name, type a different one in the answer field.` },
        { label: ATTACH_CHOICE.sessionOnly, description: 'The agent can read and change this folder in this session. No codebase is made.' },
        { label: ATTACH_CHOICE.refuse, description: 'The agent does not get this folder.' },
      ]
    : [
        { label: ATTACH_CHOICE.session, description: 'The agent can read and change this folder in this session.' },
        ...(state.codebase ? [{ label: ATTACH_CHOICE.codebase, description: `Also add the folder to the codebase "${state.codebase.name}".` }] : []),
        { label: ATTACH_CHOICE.refuse, description: 'The agent does not get this folder.' },
      ]
  // Null: the turn stopped before the person answered.
  const answer = await new Promise<string | null>((resolveAnswer) => {
    const stopped = (): void => { stop(); resolveAnswer(null) }
    const stop = answerToolQuestionWith(questionId, (answers) => {
      asker.signal.removeEventListener('abort', stopped)
      resolveAnswer(answers[ATTACH_QUESTION_ID] ?? '')
    })
    if (asker.signal.aborted) { stopped(); return }
    asker.signal.addEventListener('abort', stopped, { once: true })
    asker.emit({
      type: 'question_request',
      questionId,
      questions: [{ id: ATTACH_QUESTION_ID, header: 'Attach folder', question, options, multiSelect: false }],
    })
  })
  if (answer === null) {
    log.info('session_folder_card_answered', { sessionId, path: folder, choice: null })
    return { kind: 'not-asked', folder }
  }
  const { choice, typed } = attachAnswerOf(answer)
  log.info('session_folder_card_answered', { sessionId, path: folder, choice })
  if (formation) {
    if (choice === ATTACH_CHOICE.make) return attachNow(request, folder, false, typed ? { codebaseName: typed.slice(0, CODEBASE_NAME_MAX) } : {})
    if (choice === ATTACH_CHOICE.sessionOnly) return attachNow(request, folder, false, { sessionOnly: true })
  } else {
    if (choice === ATTACH_CHOICE.session) return attachNow(request, folder, false)
    if (choice === ATTACH_CHOICE.codebase && state.codebase) return attachNow(request, folder, true)
  }
  state.refused.add(folder)
  return { kind: 'refused', folder }
}

/**
 * Add `folder` as a root of the session's codebase on this host. The copy
 * gets a newer `updatedAt`, so each host takes it. False when the session
 * has no codebase, when a root on this host holds the folder already, and
 * when the person may not save the codebase.
 */
export async function addCodebaseRoot(state: AttachState, folder: string, actor: Actor): Promise<boolean> {
  const { sessionId } = state
  if (!state.codebaseId) return false
  const installationId = getInstallationId()
  try {
    const codebase = await codebasesFor(actor).get(state.codebaseId)
    if (!codebase || codebase.deletedAt !== null) return false
    if (codebase.roots.some((root) => root.installationId === installationId && isInsideHostPath(root.path, folder))) return false
    state.codebase = await codebasesFor(actor).save({
      ...codebase,
      roots: [...codebase.roots, await rootOf(folder)],
      updatedAt: nextUpdatedAt(codebase, Date.now()),
    })
    log.info('session_codebase_root_added', { sessionId, codebaseId: codebase.id, path: folder })
    return true
  } catch (error) {
    log.warn('session_codebase_root_failed', { sessionId, path: folder, error: error instanceof Error ? error.message : String(error) })
    return false
  }
}
