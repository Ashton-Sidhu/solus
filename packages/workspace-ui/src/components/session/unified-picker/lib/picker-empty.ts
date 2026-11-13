import { isRecordResultType, listsSessions, listsTasks, PICKER_RESULT_LABELS, type PickerResultType } from './picker-result-types'

/** What the search knows of the reads behind its list, for a list that is empty. */
export interface PickerEmptyState {
  type: PickerResultType
  query: string
  /** The scoped project's name, or null across every project. */
  scopeLabel: string | null
  tasksLoading: boolean
  /** The read of every session, for an empty box. */
  everySession: { loading: boolean; error: string | null; asked: number | null; passedOver: number }
  /** The hosts' search of sessions, under a query. */
  sessionSearch: { loading: boolean; hasErrors: boolean; indexing: boolean }
  worksLoading: boolean
  automationsLoading: boolean
  pullRequests: { loading: boolean; error: string | null; projectCount: number }
}

/** Why a list of one kind of record is empty. */
function recordEmptyMessage(state: PickerEmptyState, where: string): string {
  const query = state.query.trim()
  const { type } = state
  if (type === 'pullRequests') {
    // An empty list must not claim there is nothing when a host did not answer.
    if (state.pullRequests.error) return `Could not read pull requests: ${state.pullRequests.error}`
    if (state.pullRequests.projectCount === 0) return `No connected host has a repository to read pull requests from${where}`
    return query ? `No pull requests match “${query}”${where}` : `No open pull requests${where}`
  }
  const noun = PICKER_RESULT_LABELS[type].toLowerCase()
  // Projects are not narrowed by a project scope.
  const scope = type === 'projects' ? '' : where
  return query ? `No ${noun} match “${query}”${scope}` : `No ${noun}${scope} yet`
}

/** Why the sessions of the list could not be read in full. Null when the
 *  hosts answered in full. */
function sessionsIncompleteMessage(state: PickerEmptyState): string | null {
  const { everySession, sessionSearch } = state
  if (state.query.trim()) {
    // The toast names the hosts; the list only must not claim there is nothing.
    if (sessionSearch.hasErrors) return 'Search incomplete: not every host answered'
    return sessionSearch.indexing ? 'Indexing sessions… Search again in a moment' : null
  }
  // An empty list must not claim there is nothing when a host did not answer.
  if (everySession.error) return `Could not read sessions: ${everySession.error}`
  if (everySession.asked === 0) return 'No host to read sessions from'
  if (everySession.asked && everySession.passedOver === everySession.asked) {
    return `No connected host has a checkout of ${state.scopeLabel ?? 'this project'}`
  }
  return null
}

/**
 * Whether a read that can fill the empty list is still in flight. The list
 * then shows placeholder rows: it must not say "no pull requests" while the
 * code host has yet to answer. Only the reads of the type in view count: the
 * Tasks type does not wait for the sessions.
 */
export function pickerListLoading(state: PickerEmptyState): boolean {
  const { type } = state
  const hasQuery = !!state.query.trim()
  if (type === 'works') return state.worksLoading
  if (type === 'automations') return state.automationsLoading
  if (type === 'pullRequests') return state.pullRequests.loading
  if (type === 'projects') return false
  // With an empty box the list of every type is Recents, which holds no task.
  if (listsTasks(type) && (type === 'tasks' || hasQuery) && state.tasksLoading) return true
  if (listsSessions(type) && (hasQuery ? state.sessionSearch.loading : state.everySession.loading)) return true
  if (type !== 'all') return false
  // Recents holds works, and a query across every type can find any record.
  return state.worksLoading || (hasQuery && (state.automationsLoading || state.pullRequests.loading))
}

/**
 * What an empty list says once its reads have ended (`pickerListLoading`). It
 * has to say why it is empty, because the project scope is the most likely
 * reason and the project switcher is the answer.
 */
export function pickerEmptyMessage(state: PickerEmptyState): string {
  const { type } = state
  const query = state.query.trim()
  const where = state.scopeLabel ? ` in ${state.scopeLabel}` : ''
  if (isRecordResultType(type)) return recordEmptyMessage(state, where)
  const incomplete = listsSessions(type) ? sessionsIncompleteMessage(state) : null
  if (incomplete) return incomplete
  if (type === 'sessions') return query ? `No sessions match “${query}”${where}` : `No sessions${where} yet`
  if (type === 'tasks') return query ? `No tasks match “${query}”${where}` : `No tasks${where} yet`
  return query ? `Nothing matches “${query}”${where}` : `No recent sessions or works${where} yet`
}
