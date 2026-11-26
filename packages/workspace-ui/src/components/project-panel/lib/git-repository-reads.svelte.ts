import { untrack } from 'svelte'
import { taskFolderRootOf, type TaskFolder } from '@solus/contracts/codebases'
import { sameHostPath } from '@solus/contracts/host-path'

interface GitRepositoryReads {
  /** False while the card is hidden: a mounted tab that is not on screen reads nothing. */
  readonly active: boolean
  /** The host the session runs on. */
  readonly serverId: string
  /** The paths of the repository rows, one for each line. A text, so an equal list is an equal value. */
  readonly pathsKey: string
  environment: { watchDetails(serverId: string, cwd: string): () => void }
}

interface DraftRepositoryReads {
  /** False while the card is hidden: a mounted tab that is not on screen reads nothing. */
  readonly active: boolean
  /** The codebase of a draft whose working directory is no repository, or null. */
  readonly codebaseId: string | null
  codebases: { watch(): () => void; watchMembers(codebaseId: string): () => void }
}

/**
 * The reads of the Git card of a draft. A draft has no session folders: its
 * card lists the repositories of its codebase on the run host, so the card
 * holds the codebase and its members. A started session, and a draft with no
 * codebase, read nothing here.
 */
export function useDraftRepositoryReads(reads: DraftRepositoryReads): void {
  $effect(() => {
    const { codebaseId } = reads
    if (!reads.active || !codebaseId) return
    return untrack(() => {
      const stops = [reads.codebases.watch(), reads.codebases.watchMembers(codebaseId)]
      return () => { for (const stop of stops) stop() }
    })
  })
}

/**
 * The reads of the repository rows of the Git card. Each row shows its branch
 * and its changes, so each one holds the details of its own checkout, by its
 * own path. The Git store counts the holders: a row and the Git section of
 * the same repository share one read.
 */
export function useGitRepositoryReads(reads: GitRepositoryReads): void {
  $effect(() => {
    if (!reads.active || !reads.pathsKey) return
    const { serverId } = reads
    const paths = reads.pathsKey.split('\n')
    return untrack(() => {
      const stops = paths.map((path) => reads.environment.watchDetails(serverId, path))
      return () => { for (const stop of stops) stop() }
    })
  })
}

interface TaskFolderRead {
  /** False while the card is hidden, and for a draft: it reads nothing. */
  readonly active: boolean
  /** The working directory of the run: any path inside a task folder names it. */
  readonly path: string | null
  /** The paths of the session folders, one for each line: a repository added to the task folder changes them, and the record is read again. */
  readonly foldersKey: string
  read(root: string): Promise<TaskFolder | null>
}

/**
 * The record of the task folder that a started session works in
 * (`gitCardRepositories`). Read by the root of the task folder, so a run whose
 * Git state names a different worktree of the same task folder still finds
 * it. Null for a path outside a task folder, before the host answers, and
 * when the host refuses the read: the card then lists what it lists without
 * one. A hidden card keeps the last record and reads nothing.
 */
export function useTaskFolderRead(reads: TaskFolderRead): { readonly current: TaskFolder | null } {
  let answer = $state<{ root: string; taskFolder: TaskFolder | null } | null>(null)
  $effect(() => {
    const current = taskFolderRootOf(reads.path)
    void reads.foldersKey
    if (!reads.active || !current) return
    let isLive = true
    untrack(() => reads.read(current))
      .then((taskFolder) => { if (isLive) answer = { root: current, taskFolder } })
      .catch(() => { if (isLive) answer = { root: current, taskFolder: null } })
    return () => { isLive = false }
  })
  return {
    get current() {
      // An answer for a different task folder is not this run's.
      const root = taskFolderRootOf(reads.path)
      return answer && root && sameHostPath(answer.root, root) ? answer.taskFolder : null
    },
  }
}
