import type { WorkspaceContext } from '../../contexts/workspace/workspace.context.svelte'
import { requestFilePreview } from '../../lib/filePreview'

interface ReferenceNavigationScope {
  workingDirectory: () => string | undefined
  tabId: () => string | undefined
}

/** Default navigation for references inside an editor. An editor may override
 * any callback, but the product default always preserves the composing surface
 * and opens the reference in the companion pane. */
export function createReferenceNavigation(
  session: WorkspaceContext,
  scope: ReferenceNavigationScope,
) {
  return {
    openPlan(planId: string): void {
      void session.openPlanModal(planId, undefined, { secondary: true })
    },
    openWork(workId: string, title?: string): void {
      void session.openWorkModal(workId, title, { secondary: true })
    },
    openPr(number: number, title?: string): void {
      const workingDirectory = scope.workingDirectory()
      void session.openPullRequest({ number, title }, {
        ctx: workingDirectory
          ? session.ctxForDirectory(workingDirectory)
          : session.ctx,
        target: 'aside',
      })
    },
    openFile(path: string): void {
      requestFilePreview({
        path,
        tabId:
          scope.tabId() ?? session.focusedChatTabId ?? session.activeTabId,
      })
    },
  }
}
