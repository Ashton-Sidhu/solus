import { z } from 'zod'
import { NOTIFICATION_KINDS } from '../notification-hub'
import { workspaceIdSchema } from './schemas'

export const WORKSPACE_TOKEN_TTL_MS = 5 * 60 * 1000
export const INSIGHT_MAX_WINDOW_MS = 31 * 24 * 60 * 60 * 1000
export const INSIGHT_DEFAULT_WINDOW_MS = 7 * 24 * 60 * 60 * 1000

const page = {
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().min(1).max(2048).optional(),
}
export const workspacePageQuerySchema = z.strictObject(page)
export const workspaceTaskQuerySchema = z.strictObject({
  projectKey: z.string().max(4096).optional(),
  scope: z.enum(['all', 'inbox', 'project', 'up_next']).optional(),
  ...page,
  projectId: workspaceIdSchema.optional(),
  sessionId: workspaceIdSchema.optional(),
  status: z.enum(['inbox', 'todo', 'in_progress', 'in_review', 'done', 'dropped']).optional(),
})
export const workspaceWorkQuerySchema = z.strictObject({
  ...page,
  projectId: workspaceIdSchema.optional(),
  sessionId: workspaceIdSchema.optional(),
  type: z.enum(['doc', 'slides', 'diagram', 'artifact']).optional(),
})
/** Content search over the works a caller may open, most relevant first. One bounded answer: no cursor. */
export const workspaceWorkSearchQuerySchema = z.strictObject({
  q: z.string().trim().min(1).max(500),
  type: z.enum(['doc', 'slides', 'diagram', 'artifact']).optional(),
  limit: z.coerce.number().int().min(1).max(20).default(10),
})
export const workspaceSessionQuerySchema = z.strictObject({
  projectPath: z.string().max(4096).optional(),
  includeWorktrees: z.enum(['true', 'false']).optional(),
  /** Only chats, the sessions with no project, in every chat folder. */
  chats: z.enum(['true', 'false']).optional(),
  ...page,
  projectId: workspaceIdSchema.optional(),
  provider: z.enum(['claude-code', 'codex', 'opencode']).optional(),
})
/** The sessions a caller may open that match a query (docs/plans/unified-search.md):
 *  every word in the session's name, its metadata or any of its messages. Paged by `offset`. */
export const workspaceSessionSearchQuerySchema = z.strictObject({
  q: z.string().trim().min(1).max(500),
  /** One project root and its worktrees; omit to search every project. */
  projectRoot: z.string().max(4096).optional(),
  provider: z.enum(['claude-code', 'codex', 'opencode']).optional(),
  /** Ignored: every word matches as a prefix. Accepted from clients that still send it. */
  prefixLastToken: z.enum(['true', 'false']).optional(),
  /** Match names and metadata only; read no message. */
  namesOnly: z.enum(['true', 'false']).optional(),
  /** Only sessions last active at or after this instant (ms). */
  activeSince: z.coerce.number().int().min(0).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
  offset: z.coerce.number().int().min(0).default(0),
})
export const workspaceInsightQuerySchema = z.strictObject({
  ...page,
  since: z.iso.datetime({ offset: true }).optional(),
  until: z.iso.datetime({ offset: true }).optional(),
  userId: workspaceIdSchema.optional(),
  hostId: workspaceIdSchema.optional(),
  sessionId: workspaceIdSchema.optional(),
  provider: z.enum(['claude-code', 'codex', 'opencode']).optional(),
})
/** A record's activity: its newest `limit` rows, oldest first. One bounded answer: no cursor. */
export const workspaceActivityQuerySchema = z.strictObject({
  limit: z.coerce.number().int().min(1).max(200).default(50),
})
/** Activity that names the caller (mentions of them, shares with them) since `since`: the newest `limit` rows, oldest first. */
export const workspaceMyActivityQuerySchema = z.strictObject({
  since: z.iso.datetime({ offset: true }).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
})
/** The caller's notifications (plans/015-notifications-hub.md): one view, optionally one kind. */
export const workspaceNotificationQuerySchema = z.strictObject({
  view: z.enum(['unread', 'all', 'archived']).default('all'),
  kind: z.enum(NOTIFICATION_KINDS).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().min(1).max(2048).optional(),
})
export type WorkspaceNotificationQuery = z.input<typeof workspaceNotificationQuerySchema>
export type WorkspacePageQuery = z.infer<typeof workspacePageQuerySchema>
export type WorkspaceTaskQuery = z.infer<typeof workspaceTaskQuerySchema>
export type WorkspaceWorkQuery = z.infer<typeof workspaceWorkQuerySchema>
export type WorkspaceWorkSearchQuery = z.input<typeof workspaceWorkSearchQuerySchema>
export type WorkspaceSessionQuery = z.infer<typeof workspaceSessionQuerySchema>
export type WorkspaceSessionSearchQuery = z.input<typeof workspaceSessionSearchQuerySchema>
export type WorkspaceInsightQuery = z.infer<typeof workspaceInsightQuerySchema>
export type WorkspaceActivityQuery = z.input<typeof workspaceActivityQuerySchema>
export type WorkspaceMyActivityQuery = z.input<typeof workspaceMyActivityQuerySchema>
