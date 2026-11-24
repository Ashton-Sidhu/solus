import type { SessionFolder } from '@solus/contracts/codebases'
import type { PermissionMode } from '@solus/contracts/types'

/**
 * What a provider adapter asks about the folders of a session when the
 * provider wants a path outside its working directory
 * (docs/plans/codebases.md §6). `SessionFolders` answers. Each `sessionId` is
 * the Solus session id, not the thread id of the provider.
 */
export interface SessionFolderGate {
  /** The permission mode of the session now. */
  modeOf(sessionId: string): PermissionMode | undefined
  /**
   * The granted session folder that holds `path`, or null. A provider run
   * that started before the folder was attached does not know the folder yet.
   */
  grantedFolderOf(sessionId: string, path: string): string | null
  /**
   * Run the attach rule for a path outside the folders of the session, with
   * no card. Answers the folder when the session has it after the call: the
   * mode asks nothing (`auto`, `full-access`), or the folder is a member of
   * the session's codebase. Null in each other case.
   */
  attachUnasked(sessionId: string, path: string): Promise<string | null>
  /** The `git` folders of the session at this moment: each one gets its own turn checkpoint. */
  checkpointTargets(sessionId: string): SessionFolder[]
  /** A person allowed, for the session, a request that names `paths`: attach the folder of each path. */
  attachAllowed(sessionId: string, paths: readonly string[]): void
}
