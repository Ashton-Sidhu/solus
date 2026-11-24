import type { HostApi } from '@solus/client-core/host-api'
import type { DiffScope, IpcContext, TurnSnapshot } from '@solus/contracts/types'
import type { WorkspaceContext } from '../../contexts/workspace/workspace.context.svelte'
import { scopeInRepository, type DiffRepository } from './lib/diff-repositories'

type TurnsWorkspace = Pick<WorkspaceContext, 'lifecycle' | 'apiFor' | 'ctxFor' | 'sessionFor'>

function turnsKey(sessionId: string, repositoryPath: string): string {
  return `${sessionId}\n${repositoryPath}`
}

/**
 * The checkpointed turns of a session in one of its session folders
 * (docs/plans/codebases.md §8). Each repository counts its own snapshots, so
 * each has its own list. The list of the working directory stays in the
 * workspace lifecycle store, where the transcript's turn cards read it.
 */
export class DiffRepositoryTurnsStore {
  private turns = $state<Record<string, TurnSnapshot[]>>({})
  /** By session and repository: the newest read, so an older answer that arrives late is dropped. */
  private readonly reads = new Map<string, number>()

  /** The last list read for a session folder. Undefined before the first answer. */
  turnsFor(sessionId: string, repositoryPath: string): TurnSnapshot[] | undefined {
    return this.turns[turnsKey(sessionId, repositoryPath)]
  }

  /** Read the list again. A read that fails keeps the last list. */
  async refresh(api: HostApi, ctx: IpcContext, sessionId: string, repositoryPath: string): Promise<TurnSnapshot[]> {
    const key = turnsKey(sessionId, repositoryPath)
    const read = (this.reads.get(key) ?? 0) + 1
    this.reads.set(key, read)
    try {
      const turns = await api.listTurnSnapshots(ctx, repositoryPath)
      if (this.reads.get(key) === read) this.turns[key] = turns
    } catch {
      /* best-effort, as for the working directory */
    }
    return this.turns[key] ?? []
  }

  /**
   * The turns of one repository of a tab's session. `fresh` reads them from
   * the host; without it, the list this client has is the answer when there is
   * one. The working directory's list is the one the lifecycle store keeps.
   */
  private async turnsOf(
    workspace: TurnsWorkspace,
    tabId: string,
    repository: DiffRepository,
    fresh: boolean,
  ): Promise<readonly TurnSnapshot[]> {
    const sessionId = workspace.sessionFor(tabId)?.id
    if (!sessionId) return []
    if (repository.isWorkingDirectory) {
      if (fresh || !(sessionId in workspace.lifecycle.turnSnapshots)) await workspace.lifecycle.refreshTurnSnapshots(sessionId)
      return workspace.lifecycle.turnSnapshots[sessionId] ?? []
    }
    const known = fresh ? undefined : this.turnsFor(sessionId, repository.path)
    return known ?? this.refresh(workspace.apiFor(tabId), workspace.ctxFor(tabId), sessionId, repository.path)
  }

  /**
   * The scope that reads the same change after a move from one repository to
   * a different one. Only a turn needs the two turn lists; each other scope is
   * the same in each repository. The list of the repository that the reader
   * leaves is the one on screen. The list of the other one is read again, so
   * the turn that just ended is in it.
   */
  async scopeAcross(
    workspace: TurnsWorkspace,
    tabId: string,
    from: DiffRepository,
    to: DiffRepository,
    scope: DiffScope | undefined,
  ): Promise<DiffScope | undefined> {
    if (scope?.kind !== 'turn' || from.path === to.path) return scope
    const [fromTurns, toTurns] = await Promise.all([
      this.turnsOf(workspace, tabId, from, false),
      this.turnsOf(workspace, tabId, to, true),
    ])
    return scopeInRepository(scope, fromTurns, toTurns)
  }
}

export const diffRepositoryTurns = new DiffRepositoryTurnsStore()
