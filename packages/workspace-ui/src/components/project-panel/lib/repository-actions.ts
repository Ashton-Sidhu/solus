import type { HostApi } from '@solus/client-core/host-api'
import type { IpcContext } from '@solus/contracts/types'
import type { WorkspaceContext } from '../../../contexts/workspace/workspace.context.svelte'
import { requestInputFocus } from '../../../lib/inputFocus'
import { toasts } from '../../../lib/toasts'
import type { DirectoryFolderChoice } from '../../servers/project-picker.svelte'

/**
 * The commands for the folders and the repositories of a session
 * (docs/plans/codebases.md §9): the Environment card and the Git card of the
 * project panel call them, and so does the command palette.
 */

export const TASK_FOLDER_BRANCH_NOTE = 'A worktree of a task folder keeps the branch of its session.'

/** The text of an error for the person. */
export function errorText(error: Parameters<typeof String>[0]): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Check out a branch in a session folder. `ctx` is the context of the folder:
 * the session's id, the folder's path as the working directory, and the
 * folder's own checkout. The host does not move the session to the folder; the
 * folder's own Git events carry the change. Answers the failure text, or null.
 */
export async function checkoutFolderBranch(
  api: Pick<HostApi, 'gitCheckoutBranch'>,
  ctx: IpcContext,
  branch: string,
  options?: { create?: boolean },
): Promise<string | null> {
  try {
    const result = await api.gitCheckoutBranch(ctx, branch, options)
    return result.success ? null : result.error ?? 'The checkout failed.'
  } catch (error) {
    return errorText(error)
  }
}

/** Ask the folder browser of the app for a folder on the run host of a tab. The answer goes to `choice.onChosen`. */
export function requestFolder(tabId: string, choice: DirectoryFolderChoice): void {
  window.dispatchEvent(new CustomEvent('solus:open-directory-picker', {
    detail: { tabId, intent: 'choose-folder', folderChoice: choice },
  }))
}

/**
 * "Add folder": the person chooses a folder on the run host of a tab, and the
 * host attaches it to the session of that tab. A person attaches with no card
 * (docs/plans/codebases.md decision 8). The host's answer is the new list of
 * folders; its `session_folders` event says the same.
 */
export function addSessionFolder(workspace: Pick<WorkspaceContext, 'sessionFor' | 'apiFor'>, tabId: string): void {
  const sessionId = workspace.sessionFor(tabId)?.id
  if (!sessionId) return
  requestFolder(tabId, {
    title: 'Add a folder to this session',
    action: 'Add folder',
    onChosen: (path) => {
      void workspace.apiFor(tabId).sessionAttachFolder(sessionId, path)
        .then(
          (folders) => {
            const session = workspace.sessionFor(tabId)
            // One property changes: the tab state is never replaced.
            if (session?.id === sessionId) session.sessionFolders = folders
          },
          (error) => toasts.error("Couldn't add the folder", { description: errorText(error) }),
        )
        .finally(() => requestInputFocus({ tabId }))
    },
  })
}
