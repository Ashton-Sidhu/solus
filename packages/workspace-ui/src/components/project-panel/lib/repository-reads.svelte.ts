import { untrack } from 'svelte'

interface RepositoryReads {
  /** False while the section is hidden: a mounted tab that is not on screen reads nothing. */
  readonly active: boolean
  /** The host the session runs on. */
  readonly serverId: string
  /** The paths of the rows that are repositories, one for each line. A text, so an equal list is an equal value. */
  readonly gitPathsKey: string
  /** The codebase of the session, or null. */
  readonly codebaseId: string | null
  /** The session, when its codebase has a folder on another host: its child sessions are listed there. */
  readonly treeSessionId: string | null
  environment: { watchDetails(serverId: string, cwd: string): () => void }
  codebases: { watch(): () => void; watchMembers(codebaseId: string): () => void }
  sessionTree: { retain(serverId: string, sessionId: string): () => void }
}

/**
 * The reads of the Repositories section. Each repository row shows its branch
 * and its changes, so each one holds the details of its own checkout, by its
 * own path. The Git store counts the holders: a row and the Git section of
 * the same folder share one read.
 */
export function useRepositoryReads(reads: RepositoryReads): void {
  $effect(() => {
    if (!reads.active || !reads.gitPathsKey) return
    const { serverId } = reads
    const paths = reads.gitPathsKey.split('\n')
    return untrack(() => {
      const stops = paths.map((path) => reads.environment.watchDetails(serverId, path))
      return () => { for (const stop of stops) stop() }
    })
  })

  $effect(() => {
    if (reads.active) return untrack(() => reads.codebases.watch())
  })

  $effect(() => {
    const { codebaseId } = reads
    if (reads.active && codebaseId) return untrack(() => reads.codebases.watchMembers(codebaseId))
  })

  $effect(() => {
    const { serverId, treeSessionId } = reads
    if (reads.active && treeSessionId) return untrack(() => reads.sessionTree.retain(serverId, treeSessionId))
  })
}
