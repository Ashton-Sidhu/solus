import type { HubNotification, NotificationCount, NotificationFilter, NotificationStateResult } from '@solus/contracts/notification-hub'
import type { ShareResource } from '@solus/contracts/sharing'
import {
  workspaceNotificationArchivedSchema, workspaceNotificationQuerySchema, workspaceNotificationReadSchema,
  type SolusApiScope, type WorkspaceNotificationArchived, type WorkspaceNotificationPage,
  type WorkspaceNotificationQuery, type WorkspaceNotificationRead,
} from '@solus/contracts/solus-api'
import type { WorkspaceRequestContext } from '../../admission/workspace-credentials'
import { SolusApiError } from '../../admission/workspace-error'
import type { ShareManager } from '../../sharing/share-manager'
import { apiScope, requireResource } from '../workspace/context'
import { notificationReaderFor } from './access'
import {
  countNotifications, listNotifications, NotificationCursorError, setNotificationArchived, setNotificationRead,
  type NotificationReader,
} from './store'

const READ_SCOPE = { session: 'sessions:read', task: 'tasks:read', work: 'works:read' } as const satisfies Record<ShareResource['kind'], SolusApiScope>

/**
 * The caller's notifications on the record API (plans/015-notifications-hub.md §4).
 * The recipient is the credential's person; a row whose work or task the
 * credential may not read, by scope or by share, is left out like a record the
 * caller cannot open.
 */
export class NotificationApiOperations {
  constructor(private readonly shares: ShareManager) {}

  async list(context: WorkspaceRequestContext, input: WorkspaceNotificationQuery): Promise<WorkspaceNotificationPage> {
    const query = workspaceNotificationQuerySchema.parse(input)
    const filter: NotificationFilter = { view: query.view }
    if (query.kind) filter.kinds = [query.kind]
    const page = await this.read(context, (reader) => listNotifications(reader, { filter, cursor: query.cursor, limit: query.limit }))
    return { items: page.items, nextCursor: page.cursor }
  }

  count(context: WorkspaceRequestContext): Promise<NotificationCount> {
    return this.read(context, (reader) => countNotifications(reader))
  }

  async setRead(context: WorkspaceRequestContext, id: string, input: WorkspaceNotificationRead): Promise<HubNotification> {
    const { read } = workspaceNotificationReadSchema.parse(input)
    return answer(await this.read(context, (reader) => setNotificationRead(reader, { id, read })))
  }

  async setArchived(context: WorkspaceRequestContext, id: string, input: WorkspaceNotificationArchived): Promise<HubNotification> {
    const { archived } = workspaceNotificationArchivedSchema.parse(input)
    return answer(await this.read(context, (reader) => setNotificationArchived(reader, { id, archived })))
  }

  private async read<T>(context: WorkspaceRequestContext, run: (reader: NotificationReader) => Promise<T>): Promise<T> {
    const reader = notificationReaderFor(context.principal, apiScope(context), (resource) => this.mayOpen(context, resource))
    if (!reader) throw new SolusApiError(403, 'FORBIDDEN', 'Only a person has notifications.')
    try {
      return await run(reader)
    } catch (error) {
      if (error instanceof NotificationCursorError) throw new SolusApiError(400, 'INVALID_CURSOR', error.message)
      throw error
    }
  }

  private async mayOpen(context: WorkspaceRequestContext, resource: ShareResource): Promise<boolean> {
    if (!context.scopes.includes(READ_SCOPE[resource.kind])) return false
    try {
      await requireResource(this.shares, context, resource, 'viewer')
      return true
    } catch (error) {
      if (error instanceof SolusApiError && error.status === 404) return false
      throw error
    }
  }
}

function answer(result: NotificationStateResult): HubNotification {
  if (result.ok) return result.notification
  throw new SolusApiError(404, 'NOT_FOUND', 'Notification not found.')
}
