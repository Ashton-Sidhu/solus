import { untrack } from 'svelte'
import type { SessionFolder } from '@solus/contracts/codebases'
import type { GitIdentity } from '@solus/contracts/git-types'
import { sameHostPath } from '@solus/contracts/host-path'
import type { DiffScope } from '@solus/contracts/types'
import type { WorkspaceContext } from '../../../contexts/workspace/workspace.context.svelte'
import { conversationViewStates, type ConversationViewState } from '../../conversation/lib/conversation-view-state.svelte'
import { chosenDiffRepository, diffRepositories, type DiffRepository } from '../../diff/lib/diff-repositories'
import { moveDiffToRepository } from '../../diff/lib/repository-diff'

interface ReviewRepositoryOptions {
  workspace: WorkspaceContext
  getTabId: () => string
  /** The host fixed the checkout (a pull request prepared outside the session), so there is no choice. */
  isFixedCheckout: () => boolean
  getScope: () => DiffScope | undefined
  selectScope: (scope: DiffScope | undefined) => void
  /** What Git last said about a folder on the run host. */
  statusOf: (path: string) => GitIdentity | null | undefined
}

/** The checkout of the session folder that a review reads, for the panel's labels and file paths. */
export interface ReviewFolderCheckout {
  path: string
  branch: string
  targetBranch: string
  isWorktree: boolean
}

/**
 * Which repository of a session the review pane reads
 * (docs/plans/codebases.md §9). The choice is in the tab's view state, so it
 * is there again after a tab switch. A turn index is valid in one repository
 * only, so each move to a different repository keeps a selected turn by its
 * trace and gives the scope back to the host.
 */
export class ReviewRepository {
  constructor(private readonly opts: ReviewRepositoryOptions) {}

  private readonly view: ConversationViewState = $derived.by(() =>
    conversationViewStates(this.opts.workspace).forTab(this.opts.getTabId()))

  /** The picker's entries. Empty where the host fixed the checkout. */
  readonly repositories: DiffRepository[] = $derived.by(() =>
    this.opts.isFixedCheckout() ? [] : diffRepositories(this.opts.workspace.sessionFor(this.opts.getTabId())))

  readonly chosen: DiffRepository | null = $derived.by(() =>
    chosenDiffRepository(this.repositories, this.view.diffRepositoryPath))

  /** The session folder that the review reads. Null for the working directory. */
  private readonly folder: SessionFolder | null = $derived.by(() => {
    const chosen = this.chosen
    if (!chosen || chosen.isWorkingDirectory) return null
    return this.opts.workspace.sessionFor(this.opts.getTabId())?.sessionFolders
      .find((folder) => sameHostPath(folder.path, chosen.path)) ?? null
  })

  /** Null while the review reads the working directory: the host's own checkout facts apply. */
  readonly folderCheckout: ReviewFolderCheckout | null = $derived.by(() => {
    const folder = this.folder
    if (!folder) return null
    const status = this.opts.statusOf(folder.path)
    return {
      path: folder.path,
      branch: status?.branch ?? folder.name,
      targetBranch: status?.targetBranch ?? 'HEAD',
      isWorktree: !sameHostPath(folder.path, folder.repositoryPath),
    }
  })

  /** Put the picker on one of its entries. */
  select = async (path: string): Promise<void> => {
    const to = this.repositories.find((repository) => sameHostPath(repository.path, path))
    if (!to || to.path === this.chosen?.path) return
    const scope = this.opts.getScope()
    const moved = await moveDiffToRepository(this.opts.workspace, this.opts.getTabId(), to, scope)
    if (moved && scope?.kind === 'turn') this.opts.selectScope(moved.scope)
  }

  /**
   * A folder that left the session while the picker was on it puts the picker
   * back on the working directory. Call it from an effect: it reads the choice
   * and the entries.
   */
  leaveMissingFolder(): void {
    const path = this.view.diffRepositoryPath
    const workingDirectory = this.repositories[0]
    if (!path || !workingDirectory) return
    if (this.repositories.some((repository) => sameHostPath(repository.path, path))) return
    untrack(() => {
      const scope = this.opts.getScope()
      const left: DiffRepository = { path, name: '', isWorkingDirectory: false }
      void moveDiffToRepository(this.opts.workspace, this.opts.getTabId(), workingDirectory, scope, left)
        .then((moved) => {
          if (moved && scope?.kind === 'turn') this.opts.selectScope(moved.scope)
        })
    })
  }
}
