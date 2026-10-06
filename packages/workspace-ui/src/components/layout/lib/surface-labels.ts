import type { ReviewView, RouteName, RouteRef } from '../../../contexts/workspace/routing/route-registry'

/** Where a surface's label comes from: the stores that know each subject's name. */
export interface SurfaceTitleSources {
  sessionTitle(sessionId: string): string | undefined
  taskTitle(taskId: string): string | undefined
  workTitle(workId: string): string | undefined
  planTitle(planId: string): string | undefined
  automationName(automationId: string): string | undefined
}

const REVIEW_VIEW_LABELS = {
  diff: 'Changes',
  map: 'Change map',
  guide: 'Review guide',
  lens: 'Review lens',
} satisfies { [View in ReviewView]: string }

/** What each kind of surface is called when nothing names its subject. A
 *  destination never sits in the strip; it has a name all the same. */
const KIND_LABELS = {
  chat: 'Conversation',
  sessionRecord: 'Session',
  draft: 'New session',
  task: 'Task',
  work: 'Document',
  plan: 'Plan',
  automation: 'Automation',
  review: 'Changes',
  files: 'Files',
  subagent: 'Sub-agent',
  browser: 'Browser',
  devices: 'Devices',
  goal: 'Goal',
  prReview: 'Pull request',
  prDiff: 'Pull request diff',
  tasks: 'Tasks',
  prs: 'Pull requests',
  insights: 'Insights',
  reviewMode: 'Review',
  settings: 'Settings',
  folio: 'Workspace',
  automations: 'Automations',
  notifications: 'Notifications',
} satisfies { [Name in RouteName]: string }

/** The subject's own name, when a store knows it. */
function subjectName(ref: RouteRef, sources: SurfaceTitleSources): string | undefined {
  switch (ref.name) {
    case 'chat':
      return ref.params.sessionId ? sources.sessionTitle(ref.params.sessionId) : undefined
    case 'sessionRecord':
      return sources.sessionTitle(ref.params.sessionId)
    case 'task':
      return sources.taskTitle(ref.params.taskId)
    case 'work':
      return sources.workTitle(ref.params.workId)
    case 'plan':
      return ref.params.planId ? sources.planTitle(ref.params.planId) : undefined
    case 'automation':
      return ref.params.automationId ? sources.automationName(ref.params.automationId) : undefined
    case 'files':
      return ref.params.path?.split('/').at(-1)
    case 'review':
      return REVIEW_VIEW_LABELS[ref.params.view ?? 'diff']
    case 'prReview':
      return ref.params.title || `PR #${ref.params.number}`
    case 'prDiff':
      return `PR #${ref.params.number} diff`
    default:
      return undefined
  }
}

/** The name a surface goes by in the strip: its subject's own name when a store
 *  knows it, else what kind of thing it is. */
export function surfaceLabel(ref: RouteRef, sources: SurfaceTitleSources): string {
  return subjectName(ref, sources) || KIND_LABELS[ref.name]
}
