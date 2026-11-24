import { untrack } from 'svelte'

interface EnvironmentFolderReads {
  /** False while the card is hidden: a mounted tab that is not on screen reads nothing. */
  readonly active: boolean
  /** The host the session runs on. */
  readonly serverId: string
  /** The codebase of the session, or null. */
  readonly codebaseId: string | null
  /** The session, when its codebase has a folder on another host: its child sessions are listed there. */
  readonly treeSessionId: string | null
  codebases: { watch(): () => void; watchMembers(codebaseId: string): () => void }
  sessionTree: { retain(serverId: string, sessionId: string): () => void }
}

/**
 * The reads of the folder rows of the Environment card: the codebase of the
 * session with its members on each host, and the child sessions that work on
 * the other hosts. A session with no codebase reads nothing here.
 */
export function useEnvironmentFolderReads(reads: EnvironmentFolderReads): void {
  $effect(() => {
    if (reads.active && reads.codebaseId) return untrack(() => reads.codebases.watch())
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
