/**
 * One record of what happened to a session, a task or a work that people read
 * (plans/012-user-actor-and-activity.md §5): a stop, a decision, a rename, a
 * task change. The host stores it and sends it; every client draws it with one
 * row, and a reload reads the same rows back.
 */

import { z } from 'zod'
import { mcpAppReferenceSchema, type McpAppReference } from './mcp-apps'
import type { IssueEventKind, IssueLinkKind } from './task-types'
import type { AgentId, PermissionDecision, RateLimitDecisionAction } from './types'
import { attributionSchema, userIdSchema, userSchema, type Attribution, type User, type UserId } from './user'
import { agentIdSchema } from './types'

export interface ActivitySubject {
  kind: 'session' | 'issue' | 'work'
  id: string
}

/** What a task change points at: a linked item or a started session. */
export interface TaskEventTarget {
  kind: IssueLinkKind | 'session'
  scope?: string
  key?: string
  title?: string
}

export type ActivityKind =
  | { kind: 'mcp_app'; app: McpAppReference }
  // sessions
  | { kind: 'stopped' }
  /** The agent promoted its own session to coordinate work. */
  /** `sourceSessionId` is the source's provider thread, which opens it; `midRun`
   *  when the source was mid-turn and the fork stops at its last settled turn. */
  | { kind: 'forked'; sourceSessionId: string; sourceTitle?: string; midRun?: boolean }
  /** `projectFolder` when the session moved into the repository's main checkout, not a linked worktree. */
  | { kind: 'moved_to_worktree'; path: string; branch?: string; projectFolder?: true }
  /** The agent works in a worktree of the session's repository that the session
   *  is not bound to. The activity id is the offer id. `resolution` is never
   *  stored: a client folds the later `worktree_offer_decided` row onto it. */
  | { kind: 'worktree_offered'; path: string; branch?: string; resolution?: WorktreeOfferResolution }
  /** The answer to a `worktree_offered` row, named by that row's id. */
  | { kind: 'worktree_offer_decided'; offerId: string; resolution: WorktreeOfferResolution }
  /** The host made a codebase for the session (docs/plans/codebases.md decision 13).
   *  `name` is its name at that time: a client shows the name that the codebase has now. */
  | { kind: 'codebase_formed'; codebaseId: string; name: string }
  /** `model` and `fromModel` are model ids or, from a session switched before
   *  this record existed, the labels its lineage read. */
  | { kind: 'agent_switched'; provider: AgentId; model?: string; fromProvider?: AgentId; fromModel?: string }
  | { kind: 'plan_decided'; planId: string; decision: 'accepted' | 'rejected'; newSessionId?: string }
  | { kind: 'permission_decided'; questionId: string; tool: string; decision: PermissionDecision }
  | { kind: 'question_answered'; questionId: string }
  | { kind: 'rate_limit_decided'; action: RateLimitDecisionAction }
  /** `author` is whose held prompt it was, when the host knew. */
  | { kind: 'queued_prompt_changed'; queueId: string; change: 'removed' | 'edited'; author?: User }
  /** No longer recorded; rows stored before still parse and are not drawn. */
  | { kind: 'seat_needed'; provider: AgentId }
  /** An agent or an automation (`by`) sent a prompt into the session. Not
   *  drawn: a history read folds `by` onto the user row whose text has this
   *  hash, as its `sender` (docs/plans/prompt-sender.md). */
  | { kind: 'prompt_sent'; promptHash: string }
  // any subject
  | { kind: 'renamed'; title: string }
  | { kind: 'shared'; with: 'organization' | 'user'; userId?: UserId }
  | { kind: 'mentioned'; userId: UserId; threadId?: string }
  // tasks: a field change, a link or a started session; `from`/`to` are the
  // values already stringified (`labels_changed` holds JSON).
  | { kind: 'task_changed'; change: IssueEventKind; from?: string | null; to?: string | null; target?: TaskEventTarget }

/** What became of an offer to move the session into the agent's worktree. */
export type WorktreeOfferResolution =
  | { decision: 'switched' }
  | { decision: 'kept' }
  | { decision: 'failed'; error: string }

export type Activity = {
  id: string
  subject: ActivitySubject
  at: number
  by: Attribution
  /** A session activity inside a turn. */
  turnId?: string
} & ActivityKind


const taskEventKindSchema = z.enum([
  'created', 'status_changed', 'priority_changed', 'assignee_changed',
  'due_date_changed', 'title_changed', 'labels_changed',
  'linked', 'unlinked', 'session_started',
])

const worktreeOfferResolutionSchema: z.ZodType<WorktreeOfferResolution> = z.discriminatedUnion('decision', [
  z.object({ decision: z.literal('switched') }),
  z.object({ decision: z.literal('kept') }),
  z.object({ decision: z.literal('failed'), error: z.string() }),
])

/** An activity's kind and its fields, as a row stores them (`kind` plus `data`). */
export const activityKindSchema: z.ZodType<ActivityKind> = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('mcp_app'), app: mcpAppReferenceSchema }),
  z.object({ kind: z.literal('stopped') }),
  z.object({ kind: z.literal('forked'), sourceSessionId: z.string(), sourceTitle: z.string().optional(), midRun: z.boolean().optional() }),
  z.object({ kind: z.literal('moved_to_worktree'), path: z.string(), branch: z.string().optional(), projectFolder: z.literal(true).optional() }),
  z.object({ kind: z.literal('worktree_offered'), path: z.string(), branch: z.string().optional() }),
  z.object({ kind: z.literal('worktree_offer_decided'), offerId: z.string(), resolution: worktreeOfferResolutionSchema }),
  z.object({ kind: z.literal('codebase_formed'), codebaseId: z.string(), name: z.string() }),
  z.object({ kind: z.literal('agent_switched'), provider: agentIdSchema, model: z.string().optional(), fromProvider: agentIdSchema.optional(), fromModel: z.string().optional() }),
  z.object({ kind: z.literal('plan_decided'), planId: z.string(), decision: z.enum(['accepted', 'rejected']), newSessionId: z.string().optional() }),
  z.object({ kind: z.literal('permission_decided'), questionId: z.string(), tool: z.string(), decision: z.enum(['approved', 'approved_for_session', 'denied']) }),
  z.object({ kind: z.literal('question_answered'), questionId: z.string() }),
  z.object({ kind: z.literal('rate_limit_decided'), action: z.enum(['send_now', 'stop', 'wait']) }),
  z.object({ kind: z.literal('queued_prompt_changed'), queueId: z.string(), change: z.enum(['removed', 'edited']), author: userSchema.optional() }),
  z.object({ kind: z.literal('seat_needed'), provider: agentIdSchema }),
  z.object({ kind: z.literal('prompt_sent'), promptHash: z.string() }),
  z.object({ kind: z.literal('renamed'), title: z.string() }),
  z.object({ kind: z.literal('shared'), with: z.enum(['organization', 'user']), userId: userIdSchema.optional() }),
  z.object({ kind: z.literal('mentioned'), userId: userIdSchema, threadId: z.string().optional() }),
  z.object({
    kind: z.literal('task_changed'),
    change: taskEventKindSchema,
    from: z.string().nullable().optional(),
    to: z.string().nullable().optional(),
    target: z.object({
      kind: z.enum(['work', 'plan', 'pr', 'automation', 'session']),
      scope: z.string().optional(),
      key: z.string().optional(),
      title: z.string().optional(),
    }).optional(),
  }),
])

/** A whole activity, as a mirrored transcript row carries one. */
export const activitySchema: z.ZodType<Activity> = z.intersection(
  z.object({
    id: z.string(),
    subject: z.object({ kind: z.enum(['session', 'issue', 'work']), id: z.string() }),
    at: z.number(),
    by: attributionSchema,
    turnId: z.string().optional(),
  }),
  activityKindSchema,
)
