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
