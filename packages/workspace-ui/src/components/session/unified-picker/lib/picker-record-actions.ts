import type { Via } from '@solus/contracts/analytics-events'
import { getWorkspaceContext, hosts } from '../../../../contexts'
import { requestInputFocus } from '../../../../lib/inputFocus'
import { toasts } from '../../../../lib/toasts'
import type { PickerRecord } from './picker-records'

type WorkspaceContext = ReturnType<typeof getWorkspaceContext>

/**
 * Open a record where its own page opens it: a work in the work pane, a pull
 * request in its review, an automation in its builder. A project has no page,
 * so it opens a new session in that project, as its row in the sidebar does.
 */
export function openPickerRecord(session: WorkspaceContext, record: PickerRecord, via: Via): void {
  switch (record.type) {
    case 'work':
      void session.openWorkModal(record.item.id, record.item.title, { via })
      break
    case 'automation':
      session.openAutomations(record.automation.id, via)
      break
    case 'pullRequest': {
      const { pullRequest, serverId, projectRoot } = record.found
      void session.prReview.openPullRequest(
        { number: pullRequest.number, title: pullRequest.title, url: pullRequest.url },
        { ctx: session.ctxForDirectory(projectRoot), serverId, via },
      )
      break
    }
    case 'project': {
      const { project } = record
      if (!project.available || !hosts.get(project.serverId).me.may('host.sessions.start')) {
        toasts.error(`Can't start a session in ${project.label}`, {
          description: project.available ? 'You may not start sessions on its host.' : project.unavailableNote ?? 'Its host is not connected.',
        })
        break
      }
      session.drafts.openSessionDraft({ freshTask: true, serverId: project.serverId, via }, project.projectKey)
      requestInputFocus()
      break
    }
    case 'action':
      record.action.run()
      break
  }
}
