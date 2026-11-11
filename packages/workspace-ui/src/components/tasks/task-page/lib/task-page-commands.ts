// The commands of the task page. Each one sends a change to the host that
// reads the task, and shows the error when the host or the provider refuses.
// The page keeps the markup and its own view state.
import type {
  TaskLink,
  TaskLinkInput,
  TaskMoveTarget,
  TaskUpdatePatch,
} from '@solus/contracts/task-types'
import { serverConnections } from '@solus/client-core/server-connections'
import type { ClientShellContext, SurfaceContext } from '../../../../contexts'
import { attemptServerId } from '../../../../lib/sessionUtils'
import { copyText, toasts } from '../../../../lib/toasts'
import { PROVIDER_NAMES } from '../../lib/tasks-api'
import { linkedPrNavigationTarget } from './linked-pr-navigation'

interface TaskPageCommandsInput {
  session: SurfaceContext
  shell: ClientShellContext
  taskId: () => string
  /** A checkout of the task's project, for a linked pull request. */
  projectCwd: () => string | undefined
  /** The page's host opens the session itself, such as the Tasks page's panel. */
  onOpenSession: () => ((sessionId: string) => void) | undefined
  /** Leave the page. A deleted draft has no page to show. */
  onClose: () => void
}

export type TaskPageCommands = ReturnType<typeof createTaskPageCommands>

export function toastTaskError(action: string, error: Parameters<typeof String>[0]): void {
  toasts.error(`Couldn't ${action}`, {
    description: error instanceof Error ? error.message : String(error),
  })
}

export function createTaskPageCommands(input: TaskPageCommandsInput) {
  const { session, shell } = input
  const store = session.tasksStore
  const task = () => store.get(input.taskId())

  function notifySessionUnavailable(): void {
    toasts.error('Session no longer available', {
      description:
        'This task still has the session link, but its history is not available on the host that owns it.',
    })
  }

  /** Focus an open session once, or resume a closed one with the activation
   *  policy the action needs. `resumeSession` activates a foreground resume by
   *  itself, so the caller must not select its returned tab a second time: an
   *  already-active tab treats a second selection as an expand/collapse toggle.
   *
   *  Resolve the indexed record first. The link stores a stable session id,
   *  not which agent backend wrote it. */
  async function reveal(sessionId: string, background: boolean): Promise<string | null> {
    const workspace = session.workspace
    if (!workspace) return null
    const link = task().sessions.find((candidate) => candidate.sessionId === sessionId)
    // A directly opened task can already have loaded through the default API
    // before its Task frame was stamped with a host. `ownerHost` normally
    // repairs that placement. Keep the same default that served the page as the
    // final fallback instead of treating an unplaced frame as a deleted session.
    const taskServerId = (await task().ownerHost()) ?? serverConnections.defaultServerId()
    const serverId = attemptServerId({
      link: link ?? { executionServerId: null },
      taskServerId: taskServerId ?? null,
    })
    if (!serverId) return null
    return workspace.revealSession(sessionId, serverConnections.resolveId(serverId), { background })
  }

  async function openSessionSplit(sessionId: string): Promise<void> {
    try {
      // A split resume stays in the background. A foreground resume would make
      // the conversation the destination and put this task's strip away.
      const tabId = await reveal(sessionId, true)
      if (!tabId) return notifySessionUnavailable()
      const revealed = session.workspace?.sessionFor(tabId)
      if (revealed) session.workspace?.openChatSurface(revealed.id)
    } catch (error) {
      toastTaskError('open this session in a split', error)
    }
  }

  return {
    /** Send a change of the task's fields to the provider. False when the
     *  provider refused it: the task keeps its old value, and an editor that
     *  holds a draft of the field must take that value back. */
    async save(patch: TaskUpdatePatch): Promise<boolean> {
      try {
        await task().update(patch)
        return true
      } catch (error) {
        toastTaskError('save task', error)
        return false
      }
    },

    /** Move the task. The task entity puts the old place back when the
     *  provider refuses the move. */
    async move(target: TaskMoveTarget): Promise<void> {
      try {
        await task().move(target)
      } catch (error) {
        toastTaskError('move task', error)
      }
    },

    /** Read the task from its provider again. */
    async refresh(): Promise<void> {
      try {
        await task().loadDetails()
      } catch (error) {
        toastTaskError('refresh task', error)
      }
    },

    /** Post a comment to the provider. A comment the provider did not take
     *  stays in the feed as not sent; only a failure of the host throws. */
    async comment(body: string): Promise<void> {
      try {
        await task().comment(body)
      } catch (error) {
        toastTaskError('post comment', error)
        throw error
      }
    },

    async retryComment(commentId: string): Promise<void> {
      try {
        await task().retryComment(commentId)
      } catch (error) {
        toastTaskError('send that comment', error)
      }
    },

    async discardComment(commentId: string): Promise<void> {
      try {
        await task().discardComment(commentId)
      } catch (error) {
        toastTaskError('discard that comment', error)
      }
    },

    /** Copy the task's address on its provider. A draft has none. */
    async copyLink(): Promise<void> {
      const url = task().url
      if (!url) return
      await copyText(url)
      toasts.success('Link copied')
    },

    /** Delete a draft, with an Undo window. The provider deletes it when the
     *  window ends. */
    deleteDraft(): void {
      if (!task().canDelete) return
      const pending = store.softRemove([task().id])
      if (!pending.length) return
      toasts.undo('Task deleted', () => store.restorePending(pending), {
        onDismiss: () =>
          store.commitPending(pending).catch((error) => toastTaskError('delete task', error)),
      })
      input.onClose()
    },

    addLink(link: TaskLinkInput): void {
      void task().link(link).catch((error) => toastTaskError('link this', error))
    },

    removeLink(link: TaskLink): void {
      void store
        .get(link.taskId)
        .unlink(link.kind, link.targetKey, link.targetScope)
        .catch((error) => toastTaskError('unlink this', error))
    },

    async pinArtifact(link: TaskLink, pinned: boolean): Promise<void> {
      try {
        await store.get(link.taskId).link({
          kind: 'work',
          targetScope: link.targetScope,
          targetKey: link.targetKey,
          pinned,
        })
      } catch (error) {
        toastTaskError(pinned ? 'pin the artifact' : 'unpin the artifact', error)
      }
    },

    /** The host draws the still, so this waits on a browser; the row shows it. */
    async attachArtifact(link: TaskLink): Promise<void> {
      try {
        const linkedTask = store.get(link.taskId)
        await linkedTask.attachArtifact(link.targetKey)
        toasts.success(`Preview sent to ${PROVIDER_NAMES[linkedTask.providerId]}`)
      } catch (error) {
        toastTaskError('attach the artifact preview', error)
      }
    },

    /** A linked row opens wherever that kind lives. */
    openLink(link: TaskLink): void {
      switch (link.kind) {
        case 'work':
          shell.openResource({
            kind: 'work',
            workId: link.targetKey,
            title: link.liveTitle || link.title,
            via: 'click',
          })
          break
        // A plan and an automation live on the machine that holds them; only the
        // workspace can open one.
        case 'plan':
          void session.workspace?.openPlanModal(`${link.targetScope}__${link.targetKey}`)
          break
        case 'automation':
          session.workspace?.openAutomationBuilder(link.targetKey)
          break
        case 'pr': {
          const number = Number(link.targetKey)
          if (!Number.isFinite(number)) break
          const target = linkedPrNavigationTarget({
            taskServerId: task().serverId,
            taskProjectDirectory: input.projectCwd(),
            linkProjectDirectory: link.targetScope,
          })
          shell.openResource({
            kind: 'pull-request',
            target: { number, title: link.title, url: link.url },
            projectDirectory: target.projectDirectory ?? undefined,
            serverId: target.serverId ?? undefined,
          })
          break
        }
      }
    },

    /** A session opened from the task is a new surface beside it, so the task
     *  stays on screen (docs/plans/companion-surfaces.md, rule 6). A client with
     *  one pane shows the conversation in place of the page. */
    async openSession(sessionId: string): Promise<void> {
      const openInHost = input.onOpenSession()
      if (openInHost) return openInHost(sessionId)
      if (session.workspace?.hasCompanionPanes) return openSessionSplit(sessionId)
      try {
        const tabId = await reveal(sessionId, false)
        if (!tabId) notifySessionUnavailable()
      } catch (error) {
        toastTaskError('open this session', error)
      }
    },

    openSessionSplit,

    /** Compose a new session already bound to this task. The link lands when the
     *  draft is sent, so an abandoned composer leaves nothing behind. */
    startSession(): void {
      void session.workspace
        ?.opening.openTaskSession(task())
        .catch((error) => toastTaskError('start a session', error))
    },

    unlinkSession(sessionId: string): void {
      void task()
        .unlinkSession(sessionId)
        .catch((error) => toastTaskError('unlink this session', error))
    },

    /** `serverId` is the host that runs the session, not the host that reads
     *  the task (TaskSessionsList resolves it). */
    async stopSession(sessionId: string, serverId: string): Promise<void> {
      try {
        await serverConnections.apiFor(serverId).stopSession(sessionId)
      } catch (error) {
        toastTaskError('stop session', error)
      }
    },
  }
}
