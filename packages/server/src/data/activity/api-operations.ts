import type { Activity, ActivitySubject } from '@solus/contracts/activity'
import {
  workspaceActivityQuerySchema, workspaceMyActivityQuerySchema,
  type WorkspaceActivityList, type WorkspaceActivityQuery, type SolusApiScope, type WorkspaceMyActivityQuery,
} from '@solus/contracts/solus-api'
import { actorFor } from '../../admission/actor'
import type { WorkspaceRequestContext } from '../../admission/workspace-credentials'
import { SolusApiError } from '../../admission/workspace-error'
import type { ShareManager } from '../../sharing/share-manager'
import { apiScope, requireResource, requireScope } from '../workspace/context'
import { activityFor } from './activity'

const READ_SCOPE = { session: 'sessions:read', task: 'tasks:read', work: 'works:read' } as const satisfies Record<ActivitySubject['kind'], SolusApiScope>

/**
 * Activity on the record API (plans/012 §5, stage 8). A record's activity is
 * answered to a caller who may open that record, by the same scope and share
 * check its own read makes. Activity that names the caller (a mention of them, a
 * share with them) is what the notifications hub (D15) reads: only the caller's
 * own, and only rows whose record they may open.
 */
export class ActivityApiOperations {
  constructor(private readonly shares: ShareManager) {}

  async forRecord(context: WorkspaceRequestContext, subject: ActivitySubject, input: WorkspaceActivityQuery): Promise<WorkspaceActivityList> {
    const query = workspaceActivityQuerySchema.parse(input)
    requireScope(context, READ_SCOPE[subject.kind])
    await requireResource(this.shares, context, subject, 'viewer')
    return { items: await activityFor(apiScope(context), subject, { limit: query.limit }) }
  }

  async namingCaller(context: WorkspaceRequestContext, input: WorkspaceMyActivityQuery): Promise<WorkspaceActivityList> {
    const query = workspaceMyActivityQuerySchema.parse(input)
    const user = actorFor(context.principal).user
    if (!user) return { items: [] }
    const since = query.since ? Date.parse(query.since) : 0
    const rows = await activityFor(apiScope(context), { targetUserId: user.id, since }, { limit: query.limit })
    const opens = new Map<string, Promise<boolean>>()
    const mayOpen = (activity: Activity): Promise<boolean> => {
      const key = `${activity.subject.kind}:${activity.subject.id}`
      let open = opens.get(key)
      if (!open) {
        open = this.mayOpen(context, activity.subject)
        opens.set(key, open)
      }
      return open
    }
    const visible = await Promise.all(rows.map(mayOpen))
    return { items: rows.filter((_, index) => visible[index]) }
  }

  private async mayOpen(context: WorkspaceRequestContext, subject: ActivitySubject): Promise<boolean> {
    if (!context.scopes.includes(READ_SCOPE[subject.kind])) return false
    try {
      await requireResource(this.shares, context, subject, 'viewer')
      return true
    } catch (error) {
      if (error instanceof SolusApiError && error.status === 404) return false
      throw error
    }
  }
}
