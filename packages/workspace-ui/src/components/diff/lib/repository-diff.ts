import type { DiffScope } from '@solus/contracts/types'
import type { RouteParams } from '../../../contexts/workspace/routing/route-registry'
import type { WorkspaceContext } from '../../../contexts/workspace/workspace.context.svelte'
import { conversationViewStates, type ConversationViewState } from '../../conversation/lib/conversation-view-state.svelte'
import { diffRepositoryTurns } from '../diff-repository-turns.store.svelte'
import {
  chosenDiffRepository,
  diffFileOfSessionPath,
  diffRepositories,
  diffRepositoryNamed,
  type DiffRepository,
} from './diff-repositories'

type DiffWorkspace = Pick<WorkspaceContext, 'tabs' | 'lifecycle' | 'apiFor' | 'ctxFor' | 'sessionFor' | 'router'>

/** By view state: the newest move, so an older one that ends late changes nothing. */
const moves = new WeakMap<ConversationViewState, number>()

/**
 * Put the repository picker of a tab's diff panel on `to`. The answer is the
 * scope that reads the same change there (a turn is kept by its trace), or
 * null when a newer move replaced this one. `from` is the repository that
 * `scope` belongs to: the one the picker is on, when the caller does not say.
 */
export async function moveDiffToRepository(
  workspace: DiffWorkspace,
  tabId: string,
  to: DiffRepository,
  scope: DiffScope | undefined,
  from?: DiffRepository,
): Promise<{ scope: DiffScope | undefined } | null> {
  const view = conversationViewStates(workspace).forTab(tabId)
  const source = from ?? chosenDiffRepository(diffRepositories(workspace.sessionFor(tabId)), view.diffRepositoryPath)
  const move = (moves.get(view) ?? 0) + 1
  moves.set(view, move)
  const next = source ? await diffRepositoryTurns.scopeAcross(workspace, tabId, source, to, scope) : scope
  if (moves.get(view) !== move) return null
  view.diffRepositoryPath = to.isWorkingDirectory ? null : to.path
  return { scope: next }
}

/**
 * Open the review pane of a tab on one repository of its session.
 *
 * `repositoryPath` is the `path` or the `repositoryPath` of a `git` session
 * folder; each other path is the working directory. Null is the repository of
 * `filePath`, or the working directory when there is no file. `scope` and
 * `filePath` are as the session names them, which is how the transcript and a
 * change summary name them: a turn is a turn of the working directory's list,
 * and a file is a path from the working directory (`../api/src/a.ts`). No
 * scope opens the Changes review.
 */
export async function openRepositoryDiff(
  workspace: DiffWorkspace,
  tabId: string,
  repositoryPath: string | null,
  scope?: DiffScope,
  filePath?: string,
): Promise<void> {
  const session = workspace.sessionFor(tabId)
  const repositories = diffRepositories(session)
  const workingDirectory = repositories[0]
  if (!workingDirectory) return
  const file = filePath ? diffFileOfSessionPath(repositories, filePath) : null
  const to = (repositoryPath === null ? file?.repository : diffRepositoryNamed(session, repositoryPath)) ?? workingDirectory
  const moved = await moveDiffToRepository(workspace, tabId, to, scope, workingDirectory)
  if (!moved || !workspace.tabs[tabId]) return
  const params: RouteParams['review'] = { sourceTabId: tabId, view: 'diff' }
  if (moved.scope) params.scope = moved.scope
  // The route names a file as the diff of the chosen repository names it.
  if (file) params.filePath = file.repository?.path === to.path ? file.path : filePath
  workspace.router.navigate({ name: 'review', params })
}
