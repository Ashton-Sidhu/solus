import {
  HandPalmIcon,
  ClipboardTextIcon,
  ArrowsClockwiseIcon,
  CheckCircleIcon,
  XCircleIcon,
  StopCircleIcon,
  ClockIcon,
} from 'phosphor-svelte'
import type { Tab, Session, SessionMeta, SessionStatus, Plan } from '../../shared/types'
import type { TabGroupMode } from '../contexts/settings.context.svelte'

export type PickerEntry =
  | { kind: 'open'; tabId: string; tab: Tab; session: Session }
  | { kind: 'history'; meta: SessionMeta }

export type StatusIcon = { component: any; color: string; spin: boolean }

export type AttentionState = 'awaiting' | 'awaiting_plan' | 'error' | 'unread' | 'running' | 'queued' | null

/** True when `path` is `root` itself or nested beneath it (prefix match on
 *  path segments). Used to scope plans/works to the projects open in the
 *  sidebar — an item belongs to a project when its cwd falls under that
 *  project's repo root. */
export function isPathUnderRoot(path: string | undefined, root: string): boolean {
  if (!path) return false
  const p = path.replace(/\/+$/, '')
  const r = root.replace(/\/+$/, '')
  return p === r || p.startsWith(r + '/')
}

/** True when `path` falls under any of the given project scope roots. */
export function matchesOpenProjects(path: string | undefined, roots: string[]): boolean {
  return roots.some((r) => isPathUnderRoot(path, r))
}

function hasPendingPlanQuestion(plans: Record<string, Plan>): boolean {
  for (const id in plans) {
    const p = plans[id]
    if (p?.status === 'pending' && p.questionId) return true
  }
  return false
}

export function getAttentionState(sess: Session, tab: Tab, plans?: Record<string, Plan>): AttentionState {
  if (sess.status === 'awaiting_plan') return 'awaiting_plan'
  if (sess.status === 'awaiting_input') return 'awaiting'
  if (sess.permissionQueue.length > 0 || sess.questionQueue.length > 0) return 'awaiting'
  // This runs once per open tab inside hot derived chains (sidebar, tab strip) on
  // every stream tick, so avoid the O(messages) scan unless a relevant plan
  // actually exists. The cheap O(plans) pre-check short-circuits the common case
  // (long chats with no pending plan) where the scan would otherwise walk every
  // message and find nothing.
  if (plans && hasPendingPlanQuestion(plans)) {
    // Scan tail-first with an early break: a pending plan question is an active
    // prompt, so its plan message sits near the end of the transcript. Same
    // result as a forward .some(), but it exits fast in the common match case
    // instead of walking the whole (potentially huge) messages array.
    for (let i = sess.messages.length - 1; i >= 0; i--) {
      const m = sess.messages[i]
      if (m.role !== 'plan' || !m.planId) continue
      const p = plans[m.planId]
      if (p?.status === 'pending' && p.questionId) return 'awaiting_plan'
    }
  }
  if (sess.status === 'rate_limited') return 'queued'
  if (sess.status === 'failed' || sess.status === 'dead') return 'error'
  if (sess.status === 'completed' && tab.hasUnread) return 'unread'
  if (sess.status === 'running' || sess.status === 'connecting') return 'running'
  return null
}

export function attentionLabel(state: AttentionState): string {
  if (state === 'awaiting') return 'needs input'
  if (state === 'awaiting_plan') return 'waiting for plan'
  if (state === 'queued') return 'rate limited'
  if (state === 'error') return 'error'
  if (state === 'unread') return 'finished'
  return ''
}

export function getAttentionIcon(state: AttentionState): StatusIcon | null {
  if (state === 'awaiting')
    return { component: HandPalmIcon, color: 'var(--solus-status-permission)', spin: false }
  if (state === 'awaiting_plan')
    return { component: ClipboardTextIcon, color: 'var(--solus-status-running)', spin: false }
  if (state === 'queued')
    return { component: ClockIcon, color: 'var(--solus-status-permission)', spin: false }
  if (state === 'error')
    return { component: XCircleIcon, color: 'var(--solus-status-error)', spin: false }
  if (state === 'unread')
    return { component: CheckCircleIcon, color: 'var(--solus-status-complete)', spin: false }
  if (state === 'running')
    return { component: ArrowsClockwiseIcon, color: 'var(--solus-status-running)', spin: true }
  return null
}

export function sessionTitle(sess: Session, tab: Tab): string {
  if (tab.title && tab.title !== 'New Tab') return tab.title
  for (const m of sess.messages) {
    if (m.role === 'user' && m.content)
      return m.content.replace(/\s+/g, ' ').slice(0, 80)
  }
  return 'New session'
}

export function projectByline(sess: Session | undefined): string {
  const root = sess?.gitContext?.repoRoot ?? sess?.workingDirectory
  const dir = root?.replace(/\/$/, '')
  if (!dir || dir === '~') return '~'
  return dir.split('/').at(-1) ?? '~'
}

/** Display title for a picker entry — tab/session title for open entries, first
 *  message (or slug) for history entries. */
export function entryTitle(entry: PickerEntry): string {
  if (entry.kind === 'open') return sessionTitle(entry.session, entry.tab)
  return (
    entry.meta.customTitle ||
    entry.meta.firstMessage?.replace(/\s+/g, ' ') ||
    entry.meta.slug ||
    'Unnamed session'
  )
}

/** Project/folder byline for a picker entry. */
export function entryByline(entry: PickerEntry): string {
  if (entry.kind === 'open') return projectByline(entry.session)
  const dir = entry.meta.cwd?.replace(/\/$/, '')
  if (!dir || dir === '~') return '~'
  const parts = dir.split('/')
  return parts[parts.length - 1] || '~'
}

/** First user message of a picker entry — used for query matching. */
export function entryFirstMessage(entry: PickerEntry): string {
  if (entry.kind === 'open') {
    for (const m of entry.session.messages) {
      if (m.role === 'user' && m.content) return m.content
    }
    return ''
  }
  return entry.meta.firstMessage || ''
}

/** Last-activity timestamp (ms) for a picker entry. */
export function entryTimestamp(entry: PickerEntry): number {
  if (entry.kind === 'open') {
    const msgs = entry.session.messages
    for (let i = msgs.length - 1; i >= 0; i--) {
      if (msgs[i].timestamp) return msgs[i].timestamp as number
    }
    return 0
  }
  return new Date(entry.meta.lastTimestamp).getTime()
}

/** Relative time label from a numeric timestamp (ms). Returns null for 0/unset. */
export function formatTimeAgoFromTimestamp(ts: number): string | null {
  if (!ts) return null
  const diff = Date.now() - ts
  const mins = Math.floor(diff / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  if (days < 7) return `${days}d ago`
  return new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

export function branchKeyFor(sess: Session | undefined): string {
  const root = sess?.gitContext?.repoRoot ?? sess?.workingDirectory ?? '~'
  const branch = sess?.gitContext?.branch ?? 'no branch'
  const worktreeSuffix = sess?.gitContext?.worktreePath ? ' (worktree)' : ''
  return `${root}::${branch}${worktreeSuffix}`
}

export function getStatusIcon(status: SessionStatus): StatusIcon | null {
  if (status === 'awaiting_input')
    return { component: HandPalmIcon, color: 'var(--solus-status-permission)', spin: false }
  if (status === 'awaiting_plan')
    return { component: ClipboardTextIcon, color: 'var(--solus-status-running)', spin: false }
  if (status === 'rate_limited')
    return { component: ClockIcon, color: 'var(--solus-status-permission)', spin: false }
  if (status === 'running' || status === 'connecting')
    return { component: ArrowsClockwiseIcon, color: 'var(--solus-status-running)', spin: true }
  if (status === 'failed' || status === 'dead')
    return { component: XCircleIcon, color: 'var(--solus-status-error)', spin: false }
  if (status === 'completed')
    return { component: CheckCircleIcon, color: 'var(--solus-status-complete)', spin: false }
  if (status === 'interrupted')
    return { component: StopCircleIcon, color: 'var(--solus-status-permission)', spin: false }
  return null
}

export type StatusGroupKey = 'waiting' | 'rate-limited' | 'running' | 'completed' | 'error' | 'idle'

export const STATUS_GROUP_ORDER: StatusGroupKey[] = [
  'waiting', 'rate-limited', 'running', 'completed', 'error', 'idle'
]

export const STATUS_GROUP_LABELS: Record<StatusGroupKey, string> = {
  'waiting': 'Waiting for input',
  'rate-limited': 'Rate limited',
  'running': 'Running',
  'completed': 'Completed',
  'error': 'Error',
  'idle': 'Idle',
}

export function getStatusGroupKey(sess: Session, tab: Tab, plans?: Record<string, Plan>): StatusGroupKey {
  const attention = getAttentionState(sess, tab, plans)
  if (attention === 'awaiting' || attention === 'awaiting_plan') return 'waiting'
  if (attention === 'queued') return 'rate-limited'
  if (attention === 'running') return 'running'
  if (attention === 'error') return 'error'
  if (sess.status === 'completed') return 'completed'
  return 'idle'
}

export type UnreadGroupKey = 'unread' | 'read'

export const UNREAD_GROUP_ORDER: UnreadGroupKey[] = ['unread', 'read']

export const UNREAD_GROUP_LABELS: Record<UnreadGroupKey, string> = {
  'unread': 'Unread',
  'read': 'Read',
}

export function getUnreadGroupKey(sess: Session, tab: Tab, plans?: Record<string, Plan>): UnreadGroupKey {
  return getAttentionState(sess, tab, plans) === 'unread' ? 'unread' : 'read'
}

export type TabGroupSection = { key: string; tabIds: string[] }
export type TabResolver = (tabId: string) => { sess: Session; tab: Tab } | null

/** Per-mode bucketing rule: the section order and how a tab maps to a section. */
const GROUP_DEFS: Record<'status' | 'unread', {
  order: readonly string[]
  keyOf: (sess: Session, tab: Tab, plans?: Record<string, Plan>) => string
}> = {
  status: { order: STATUS_GROUP_ORDER, keyOf: getStatusGroupKey },
  unread: { order: UNREAD_GROUP_ORDER, keyOf: getUnreadGroupKey },
}

/**
 * Bucket tab IDs into ordered grouping sections — the single source of truth for
 * how tabs are arranged in grouped views. `flat` keeps the original order as one
 * section; `status` / `unread` reorder into their group buckets. Both the tab
 * strip (visual rows) and keyboard tab navigation read from this, so what the user
 * sees and what next/prev-tab cycles through can never diverge.
 */
export function buildTabSections(
  tabIds: string[],
  mode: TabGroupMode,
  resolve: TabResolver,
  plans?: Record<string, Plan>,
): TabGroupSection[] {
  if (mode === 'flat') return [{ key: 'flat', tabIds }]
  const { order, keyOf } = GROUP_DEFS[mode]
  const groups = new Map<string, string[]>()
  for (const tabId of tabIds) {
    const r = resolve(tabId)
    if (!r) continue
    const key = keyOf(r.sess, r.tab, plans)
    let arr = groups.get(key)
    if (!arr) {
      arr = []
      groups.set(key, arr)
    }
    arr.push(tabId)
  }
  const result: TabGroupSection[] = []
  for (const key of order) {
    const arr = groups.get(key)
    if (arr && arr.length > 0) result.push({ key, tabIds: arr })
  }
  return result
}

export function formatMessageTime(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
}

export function formatTimeAgo(isoDate: string): string {
  const diff = Date.now() - new Date(isoDate).getTime()
  const mins = Math.floor(diff / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  if (days < 7) return `${days}d ago`
  return new Date(isoDate).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

export type DateGroup = 'Today' | 'Yesterday' | 'This week' | 'This month' | 'Older'

export function getDateGroup(timestamp: number): DateGroup {
  const now = new Date()
  const date = new Date(timestamp)

  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
  const startOfYesterday = startOfToday - 86_400_000
  const dayOfWeek = now.getDay() === 0 ? 7 : now.getDay()
  const startOfWeek = startOfToday - (dayOfWeek - 1) * 86_400_000
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1).getTime()

  const ts = date.getTime()
  if (ts >= startOfToday) return 'Today'
  if (ts >= startOfYesterday) return 'Yesterday'
  if (ts >= startOfWeek) return 'This week'
  if (ts >= startOfMonth) return 'This month'
  return 'Older'
}

export function findOpenTabForSession(
  sessionId: string,
  tabs: Record<string, Tab>,
  sessions: Record<string, Session>,
  tabOrder: string[],
  provider?: SessionMeta['provider'],
): string | null {
  for (const tabId of tabOrder) {
    const tab = tabs[tabId]
    if (!tab) continue
    const sess = sessions[tab.sessionId]
    if (sess?.agentSessionId === sessionId && (!provider || sess.provider === provider)) return tabId
  }
  return null
}
