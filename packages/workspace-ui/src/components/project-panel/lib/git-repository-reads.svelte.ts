import { untrack } from 'svelte'

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
