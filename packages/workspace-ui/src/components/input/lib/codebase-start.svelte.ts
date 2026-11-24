import { untrack } from 'svelte'
import type { Codebase } from '@solus/contracts/codebases'
import type { Place, RunConfig, RunLocation } from '@solus/contracts/types'
import { hostPathKey } from '@solus/contracts/host-path'
import { isChat } from '@solus/contracts/chat'
import type { CodebaseHost } from '../../../contexts/codebases/codebases.store.svelte'
import { checkoutPlace, chooseCodebase, codebaseOf, pendingClone } from '../../../contexts/workspace/run-location'
import { automaticCodebase } from './codebase-choice'
import type { CodebaseDecisions } from './project-selection'

interface CodebaseStartReads {
  /** The tab or draft the strip describes. */
  readonly sourceId: string
  /** Its run, or undefined while it has none of its own. */
  readonly run: RunConfig | undefined
  /** The session of the tab has a first turn: no codebase is chosen for it without the person. */
  readonly isStarted: boolean
  store: {
    readonly hosts: readonly Pick<CodebaseHost, 'serverId' | 'status'>[]
    watch(): () => void
    watchMembers(codebaseId: string): () => void
    isDeleted(codebaseId: string): boolean
    codebasesOfFolder(serverId: string, path: string): Codebase[]
    readFolder(serverId: string, path: string): Promise<void>
  }
  /** The project folder of the run: the root of its repository, else its folder. The project covers the repositories inside it. */
  readonly projectFolder: string
  decisions: Pick<CodebaseDecisions, 'isDecided' | 'note'>
  applyLocation(next: RunLocation): void
  /** The run asks for a new worktree of a folder with no repository, and the person named no base branch. */
  readonly needsBaseBranch: boolean
  /** Open the start control, where the base branch field is. */
  openStartControl(): void
}

/** The folder whose codebases decide the automatic choice, or null when the run has none to decide for. */
function decidableFolder(run: RunConfig | undefined, isStarted: boolean): Place | null {
  // A clone has no folder on its run host until Send.
  if (!run || isStarted || pendingClone(run)) return null
  const folder = checkoutPlace(run)
  return folder.path && folder.path !== '~' && !isChat(folder.path) ? folder : null
}

/**
 * The codebase reads of the destination strip (docs/plans/codebases.md §9,
 * "Start"). While the strip shows, the list of codebases is current, and so
 * are the members of the run's codebase.
 *
 * A run whose codebase is deleted has no codebase: a person deleted it on a
 * different client, or the record of the session names it still. This applies
 * to a started session also, and the host makes no codebase for that folder
 * again.
 *
 * A folder that is in exactly one codebase starts with that codebase. It is
 * decided one time for each folder, so "No codebase" stays the person's
 * choice. The directory picker moves a draft outside the strip, so the run is
 * observed, not the click on the project chip.
 *
 * A project covers the repositories inside it, with no codebase (decision
 * 14). The project folder is read here, one time for each folder, so the
 * start control lists those repositories for a new worktree before Send.
 *
 * The worktree shortcut asks for a new worktree with no menu open. A folder
 * with no repository has no branch for that worktree, so the start control
 * opens on its base branch field. A run that was restored in that state opens
 * nothing: the person did not just ask.
 */
export function useCodebaseStart(reads: CodebaseStartReads): void {
  $effect(() => untrack(() => reads.store.watch()))

  $effect(() => {
    const codebaseId = codebaseOf(reads.run)
    if (codebaseId) return untrack(() => reads.store.watchMembers(codebaseId))
  })

  $effect(() => {
    const { run } = reads
    const codebaseId = codebaseOf(run)
    if (!run || !codebaseId || !reads.store.isDeleted(codebaseId)) return
    untrack(() => reads.applyLocation(chooseCodebase(run.location, null)))
  })

  $effect(() => {
    const { run, sourceId } = reads
    const folder = decidableFolder(run, reads.isStarted)
    if (!run || !folder || reads.decisions.isDecided(sourceId, folder)) return
    const isHostRead = reads.store.hosts.some((host) => host.serverId === folder.serverId && host.status === 'ready')
    const choice = automaticCodebase(codebaseOf(run), isHostRead ? reads.store.codebasesOfFolder(folder.serverId, folder.path) : null)
    if (choice === undefined) return
    untrack(() => {
      reads.decisions.note(sourceId, folder)
      if (choice) reads.applyLocation(chooseCodebase(run.location, choice))
    })
  })

  let readFolderKey: string | null = null
  $effect(() => {
    const { run, projectFolder } = reads
    const folder = decidableFolder(run, reads.isStarted)
    if (!folder || !projectFolder) return
    if (!reads.store.hosts.some((host) => host.serverId === folder.serverId && host.status === 'ready')) return
    const key = `${folder.serverId}\n${hostPathKey(projectFolder)}`
    if (key === readFolderKey) return
    readFolderKey = key
    untrack(() => void reads.store.readFolder(folder.serverId, projectFolder))
  })

  let neededBaseBranch: boolean | null = null
  $effect(() => {
    const needsBaseBranch = reads.needsBaseBranch
    if (needsBaseBranch && neededBaseBranch === false) untrack(() => reads.openStartControl())
    neededBaseBranch = needsBaseBranch
  })
}
