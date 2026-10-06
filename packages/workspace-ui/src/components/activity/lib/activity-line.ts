import type { Activity } from '@solus/contracts/activity'
import { sameUser, type User, type UserId } from '@solus/contracts/user'
import { z } from 'zod'
import { labelChangeText } from '../../../lib/label-activity'
import {
  attributionName,
  heldPromptOwner,
  otherPerson,
  permissionDecisionNotice,
  rateLimitDecisionNotice,
} from '../../presence/lib/actor-name'
import { STATUS_META } from '../../tasks/lib/tasks-api'

/**
 * One activity as one sentence (plans/012 §5): who did it, then what they did.
 * `person` is the doer to draw as a user chip — a person other than the reader;
 * otherwise `who` names them in words ("You", "Solus agent", "Solus"). `text` is
 * the whole sentence for plain readers.
 */
export interface ActivityLine {
  person: User | null
  who: string
  predicate: string
  text: string
  /** The glyph for the task feed's disc: an SVG path on a 14px box. */
  glyph: string
}

const GLYPHS = {
  plus: 'M7 2.6v8.8M2.6 7h8.8',
  arrow: 'M2.6 7h8.8M8 3.6L11.4 7 8 10.4',
  link: 'M5.8 8.2a2.2 2.2 0 003.3.2l2-2a2.2 2.2 0 00-3.1-3.1l-1.1 1.1M8.2 5.8a2.2 2.2 0 00-3.3-.2l-2 2a2.2 2.2 0 003.1 3.1l1.1-1.1',
  clock: 'M7 12.6A5.6 5.6 0 107 1.4a5.6 5.6 0 000 11.2M7 4.4V7l2 1.2',
} as const

/** `self` is the reader on the subject's host: "you" names only them. */
export function activityLine(activity: Activity, self: UserId | null): ActivityLine {
  const name = attributionName(activity.by, self)
  const who = name.charAt(0).toUpperCase() + name.slice(1)
  const person = activity.by.kind === 'user' ? otherPerson(activity.by.user, self) : null
  const line = (predicate: string, glyph: string = GLYPHS.arrow): ActivityLine => ({ person, who, predicate, text: `${who} ${predicate}`, glyph })
  if (activity.kind === 'task_changed') return taskLine(activity, line)
  const divider = dividerPredicate(activity)
  // A divider reads as the thread's own news ("Forked from …"), as it always
  // did; it names the doer only when that is someone other than the reader.
  if (divider && !person) {
    const predicate = divider.charAt(0).toUpperCase() + divider.slice(1)
    return { person, who: '', predicate, text: predicate, glyph: GLYPHS.arrow }
  }
  return line(divider ?? sessionPredicate(activity, self) ?? subjectPredicate(activity, self))
}

/**
 * A fork, a move into a worktree, an agent switch, or a plan accepted into a
 * fresh agent session is a statement about the thread itself: it opens a turn
 * rather than sitting in one, and every reader sees it, the one who did it too.
 */
export function dividesThread(activity: Activity): boolean {
  return dividerPredicate(activity) !== null
}

/** The words before a divider's title (a session, a branch, a plan, an agent). */
function dividerPredicate(activity: Activity): string | null {
  switch (activity.kind) {
    case 'forked': return activity.midRun ? 'forked mid-run from' : 'forked from'
    case 'moved_to_worktree': return 'continued in worktree'
    case 'agent_switched': return 'continued with'
    case 'plan_decided': return activity.newSessionId ? 'started a new session implementing' : null
    default: return null
  }
}

/** What was done to a session; null for a kind any subject can have. */
function sessionPredicate(activity: Activity, self: UserId | null): string | null {
  switch (activity.kind) {
    case 'stopped': return 'stopped the agent'
    case 'plan_decided': return `${activity.decision} the plan`
    // A plan is approved through its permission; its card holds the plan itself.
    case 'permission_decided': return permissionDecisionNotice(activity.decision, activity.tool === 'ExitPlanMode' ? 'the plan' : activity.tool)
    case 'question_answered': return 'answered the question'
    case 'rate_limit_decided': return rateLimitDecisionNotice(activity.action)
    case 'queued_prompt_changed': return `${activity.change} ${heldPromptOwner(activity.author, self)} held prompt`
    case 'worktree_offered': return `found the agent working in worktree ${activity.branch || activity.path}`
    case 'worktree_offer_decided': return worktreeOfferPredicate(activity.resolution.decision)
    case 'seat_needed': return `needs to connect a ${activity.provider === 'codex' ? 'Codex' : 'Claude'} seat on this host`
    default: return null
  }
}

function worktreeOfferPredicate(decision: 'switched' | 'kept' | 'failed'): string {
  if (decision === 'switched') return "switched to the agent's worktree"
  if (decision === 'kept') return 'kept the current checkout'
  return "could not switch to the agent's worktree"
}

/** What was done to any subject: a rename, a share, a mention. */
function subjectPredicate(activity: Activity, self: UserId | null): string {
  const subject = activity.subject.kind
  switch (activity.kind) {
    case 'renamed': return `renamed this ${subject}`
    case 'shared': return activity.with === 'organization' ? `shared this ${subject} with the organization` : `shared this ${subject}`
    case 'mentioned': return self && sameUser(activity.userId, self) ? 'mentioned you' : 'mentioned a teammate'
    default: return `changed this ${subject}`
  }
}

function taskLine(
  activity: Extract<Activity, { kind: 'task_changed' }>,
  line: (predicate: string, glyph?: string) => ActivityLine,
): ActivityLine {
  const target = activity.target?.title || activity.target?.key || ''
  switch (activity.change) {
    case 'created': return line('created this task', GLYPHS.plus)
    case 'status_changed': return line(`moved this to ${statusName(activity.to)}`)
    case 'priority_changed': return line(`set priority to ${activity.to ?? 'none'}`)
    case 'assignee_changed': return line(`assigned this to ${activity.to ?? 'nobody'}`)
    case 'due_date_changed': return line(`set the target to ${activity.to ?? 'none'}`)
    case 'title_changed': return line('renamed this task')
    case 'labels_changed': return line(labelsChangedPredicate(activity.from, activity.to))
    case 'linked': return line(`linked ${target}`, GLYPHS.link)
    case 'unlinked': return line(`unlinked ${target}`, GLYPHS.link)
    // A session starting is the task's own news: it names no one.
    case 'session_started': return { person: null, who: '', predicate: 'Session started', text: 'Session started', glyph: GLYPHS.clock }
  }
}

/**
 * Whether a session activity is drawn as a row of its own for this reader. A
 * stop always is: the turn's end absorbs it and names who stopped. So is a
 * divider (`dividesThread`), which is the thread's own news. Anything
 * else a person did shows only when that person is not the reader, so a
 * session where the reader acts alone stays quiet (plan 004 D2) and a missing
 * reader never reads as "you".
 */
export function showsActivity(activity: Activity, self: UserId | null): boolean {
  if (activity.kind === 'stopped' || dividesThread(activity)) return true
  if (activity.by.kind !== 'user') return true
  return otherPerson(activity.by.user, self) !== null
}

const labelSnapshotSchema = z.array(z.string())

/** Decode the JSON snapshot a label change carries. Null when the row has none
 *  or it is not a list of names: this runs on a render path, so a bad row has
 *  to read as a plain "changed the labels" rather than take the page down. */
function labelSnapshot(value: string | null | undefined): string[] | null {
  if (value == null) return null
  try {
    const parsed = labelSnapshotSchema.safeParse(JSON.parse(value))
    return parsed.success ? parsed.data : null
  } catch {
    return null
  }
}

function labelsChangedPredicate(fromValue: string | null | undefined, toValue: string | null | undefined): string {
  const before = labelSnapshot(fromValue)
  const after = labelSnapshot(toValue)
  if (!before || !after) return 'changed the labels'
  const beforeNames = new Set(before)
  const afterNames = new Set(after)
  const added = after.filter((label) => !beforeNames.has(label))
  const removed = before.filter((label) => !afterNames.has(label))
  if (!added.length && !removed.length) return 'changed the labels'
  return labelChangeText('', added, removed).trimStart()
}

function statusName(status: string | null | undefined): string {
  if (!status) return 'unknown'
  return Object.entries(STATUS_META).find(([key]) => key === status)?.[1].label ?? status
}
