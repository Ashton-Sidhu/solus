import { z } from 'zod'
import { activitySchema } from '../activity'
import { hubNotificationSchema } from '../notification-hub'

const datetime = z.iso.datetime({ offset: true })
const nullableText = (max: number) => z.string().max(max).nullable()
const uniqueItems = <T>(items: T[]) => new Set(items).size === items.length
const page = <T extends z.ZodType>(item: T) => z.strictObject({
  items: z.array(item).max(200),
  nextCursor: z.string().max(2048).nullable(),
})

export const solusApiScopeSchema = z.enum(['tasks:read', 'tasks:write', 'works:read', 'works:write', 'sessions:read', 'sessions:admit', 'insights:read'])
export type SolusApiScope = z.infer<typeof solusApiScopeSchema>

export const workspaceIdSchema = z.string().min(1).max(256).regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/)
export type WorkspaceId = z.infer<typeof workspaceIdSchema>

export const workspaceVersionSchema = z.string().min(1).max(128)
  .meta({ description: 'Opaque resource version. Send its quoted value in If-Match. Never infer ordering from it.' })
export type WorkspaceVersion = z.infer<typeof workspaceVersionSchema>

export const workspaceRecordHomeSchema = z.union([
  z.strictObject({ kind: z.literal('local'), hostId: workspaceIdSchema }),
  z.strictObject({ kind: z.literal('organization'), serviceId: workspaceIdSchema, organizationId: workspaceIdSchema }),
]).meta({ description: 'The authority for this record. Local home is distinct from organization attribution. A Local record can have a saved organization without being published.' })
export type WorkspaceRecordHome = z.infer<typeof workspaceRecordHomeSchema>

export const workspaceActorSchema = z.strictObject({
  kind: z.enum(['user', 'agent', 'automation', 'system']),
  userId: workspaceIdSchema.nullable(),
  displayName: z.string().max(256),
  sessionId: workspaceIdSchema.nullable(),
})
export type WorkspaceActor = z.infer<typeof workspaceActorSchema>

export const workspaceErrorCodeSchema = z.enum(['INVALID_REQUEST', 'INVALID_CURSOR', 'UNAUTHENTICATED', 'FORBIDDEN', 'NOT_FOUND', 'MOVED', 'CONFLICT', 'STALE_VERSION', 'IDEMPOTENCY_CONFLICT', 'PAYLOAD_TOO_LARGE', 'RATE_LIMITED', 'CAPABILITY_UNAVAILABLE', 'READ_ONLY_RESOURCE', 'INTERNAL_ERROR'])
export type WorkspaceErrorCode = z.infer<typeof workspaceErrorCodeSchema>

export const workspaceErrorSchema = z.strictObject({
  error: z.strictObject({
    code: workspaceErrorCodeSchema,
    message: z.string().max(2048),
    requestId: workspaceIdSchema,
    issues: z.array(z.strictObject({
      path: z.array(z.union([z.string().max(128), z.number().int().min(0)])).max(20),
      message: z.string().max(1024),
    })).max(100).optional(),
  }),
}).meta({ examples: [{ error: { code: 'STALE_VERSION', message: 'Read the latest version before saving.', requestId: 'req_example' } }] })
export type WorkspaceError = z.infer<typeof workspaceErrorSchema>

/** The fields every record carries. Home and owner come from verified request context, never from the caller. */
const record = {
  id: workspaceIdSchema,
  home: workspaceRecordHomeSchema,
  organizationId: workspaceIdSchema.nullable(),
  ownerUserId: workspaceIdSchema,
  version: workspaceVersionSchema,
  createdAt: datetime,
  updatedAt: datetime,
}

// Auth and discovery

export const workspaceAuthSessionRequestSchema = z.strictObject({
  scopes: z.array(solusApiScopeSchema).min(1).max(7).refine(uniqueItems, 'Duplicate values are not allowed.').meta({ uniqueItems: true }),
  shareSecret: z.string().min(32).max(256).meta({ writeOnly: true }).optional(),
}).meta({ description: 'Source authority determines the actor, service and Local or organization context. No organization selector is accepted here. A resource-bound guest grant also requires its shareSecret. Requested scopes only narrow authority.', examples: [{ scopes: ['tasks:read', 'tasks:write'] }] })
export type WorkspaceAuthSessionRequest = z.infer<typeof workspaceAuthSessionRequestSchema>

export const workspaceAuthSessionSchema = z.strictObject({
  accessToken: z.string().min(1).max(4096).meta({ 'x-solus-sensitive': true }),
  tokenType: z.literal('Bearer'),
  expiresAt: datetime,
  scopes: z.array(solusApiScopeSchema).max(7).refine(uniqueItems, 'Duplicate values are not allowed.').meta({ uniqueItems: true }),
  home: workspaceRecordHomeSchema,
  subject: workspaceActorSchema,
}).meta({ description: 'Verified source authority fixes the actor and home in this credential. At most five minutes and never beyond source expiry. Renewal requires source authority; this bearer cannot renew itself. Keep credentials out of URLs, logs and artifacts.' })
export type WorkspaceAuthSession = z.infer<typeof workspaceAuthSessionSchema>

export const workspaceCapabilitiesSchema = z.strictObject({
  serviceId: workspaceIdSchema,
  mode: z.enum(['combined-host', 'solus-api']),
  apiVersion: z.string().max(32),
  capabilities: z.array(z.enum(['tasks', 'works', 'session-records', 'insights', 'notifications'])).max(5).refine(uniqueItems, 'Duplicate values are not allowed.').meta({ uniqueItems: true }),
  events: z.strictObject({ transport: z.literal('socket.io'), relativePath: z.literal('/ws'), protocolVersion: z.number().int().min(1) }),
}).meta({ description: 'Features supported by this deployment, not permission grants. Insights currently requires organization context. HTTP works without a connected event socket.' })
export type WorkspaceCapabilities = z.infer<typeof workspaceCapabilitiesSchema>

// Tasks

const taskStatus = z.enum(['inbox', 'todo', 'in_progress', 'in_review', 'done', 'dropped'])
const taskPriority = z.enum(['urgent', 'high', 'medium', 'low'])
const taskLabels = z.array(z.string().min(1).max(100)).max(100)
const taskExample = { id: 'task_example', home: { kind: 'local', hostId: 'host_example' }, organizationId: null, ownerUserId: 'local:host_user_example', version: 'v1-example', createdAt: '2026-09-28T16:00:00Z', updatedAt: '2026-09-28T16:00:00Z', title: 'Review the API contract', projectKey: null, projectId: null, status: 'todo', assignee: null, priority: 'medium', labels: ['api'], dueDate: null, originSessionId: null, shortId: 1 }

export const workspaceTaskSummarySchema = z.strictObject({
  ...record,
  title: z.string().min(1).max(500),
  /** The project directory or repository key; null is the global inbox. */
  projectKey: nullableText(4096),
  projectId: workspaceIdSchema.nullable(),
  status: taskStatus,
  assignee: nullableText(256),
  /** The Solus person assigned, by user id. `assignee` stays the display or provider name. */
  assigneeUserId: workspaceIdSchema.nullable().optional(),
  priority: taskPriority.nullable(),
  labels: taskLabels,
  dueDate: z.iso.date().nullable(),
  originSessionId: workspaceIdSchema.nullable(),
  shortId: z.number().int().min(1).nullable(),
  titleSource: z.enum(['prompt', 'generated', 'manual']).optional(),
  source: z.enum(['user', 'agent', 'automation', 'import']).optional(),
  originAutomationId: z.string().max(256).optional(),
  triagedAt: z.number().int().optional(),
  doneAt: z.number().int().optional(),
  lastReadAt: z.number().int().optional(),
  pr: z.strictObject({ url: z.string().max(4096), number: z.number().int() }).optional(),
  mirroredTicket: z.strictObject({ provider: z.enum(['github', 'jira']), externalId: z.string().max(256), url: z.string().max(4096) }).optional(),
}).meta({ description: 'Task metadata without the body. Read an individual task for its full body. Links and comments remain on their existing routes.', examples: [taskExample] })
export type WorkspaceTaskSummary = z.infer<typeof workspaceTaskSummarySchema>

export const workspaceTaskSchema = workspaceTaskSummarySchema.extend({ body: z.string().max(1000000) })
  .meta({ description: 'Preserve existing ownership, parent-access and sharing rules. Organization membership alone does not bypass resource access.', examples: [{ ...taskExample, body: 'Check the task endpoints.' }] })
export type WorkspaceTask = z.infer<typeof workspaceTaskSchema>

export const workspaceCreateTaskSchema = z.strictObject({
  title: z.string().min(1).max(500),
  body: z.string().max(1000000).optional(),
  projectKey: nullableText(4096).optional(),
  projectId: workspaceIdSchema.nullable().optional(),
  status: taskStatus.optional(),
  assignee: nullableText(256).optional(),
  assigneeUserId: workspaceIdSchema.nullable().optional(),
  priority: taskPriority.nullable().optional(),
  labels: taskLabels.optional(),
  dueDate: z.iso.date().nullable().optional(),
  originSessionId: workspaceIdSchema.nullable().optional(),
}).meta({ examples: [{ title: 'Review the API contract', status: 'todo' }] })
export type WorkspaceCreateTask = z.infer<typeof workspaceCreateTaskSchema>

export const workspaceUpdateTaskSchema = workspaceCreateTaskSchema.omit({ originSessionId: true }).partial()
  .refine(value => Object.keys(value).length > 0, 'At least one field is required.')
  .meta({ examples: [{ status: 'in_review' }], minProperties: 1 })
export type WorkspaceUpdateTask = z.infer<typeof workspaceUpdateTaskSchema>

export const workspaceTaskPageSchema = page(workspaceTaskSummarySchema)
export type WorkspaceTaskPage = z.infer<typeof workspaceTaskPageSchema>

// Works

const workType = z.enum(['doc', 'slides', 'diagram', 'artifact', 'insights-report'])
const agentProvider = z.enum(['claude-code', 'codex', 'opencode'])
const workExample = { id: 'work_example', home: { kind: 'local', hostId: 'host_example' }, organizationId: null, ownerUserId: 'local:host_user_example', version: 'v1-example', createdAt: '2026-09-28T16:00:00Z', updatedAt: '2026-09-28T16:00:00Z', title: 'API notes', type: 'doc', preview: 'Review notes', sessionIds: [], projectId: null, pinned: false, editable: true, cwd: '~', agentProvider: 'codex' }

export const workspaceLinkedDocumentSchema = z.strictObject({
  provider: z.enum(['gdrive', 'confluence']),
  externalKey: z.string().max(512),
  externalId: z.string().max(512),
  url: z.string().max(4096),
  scope: z.string().max(512),
  upstreamVersion: z.string().max(256).optional(),
  lastPushedContentHash: z.string().max(256).optional(),
  upstreamContentHash: z.string().max(256).optional(),
  syncState: z.enum(['ok', 'dirty', 'upstream_changed', 'conflict', 'error', 'auth_error']),
  syncError: z.string().max(4096).optional(),
  googleImages: z.array(z.strictObject({ workId: z.string(), title: z.string(), objectId: z.string(), tabId: z.string(), sourceUri: z.string(), contentHash: z.string() })).max(200).optional(),
  diagrams: z.array(z.strictObject({ workId: z.string(), title: z.string() })).max(200).optional(),
})

export const workspaceWorkSummarySchema = z.strictObject({
  ...record,
  title: z.string().min(1).max(500),
  type: workType,
  preview: z.string().max(2000),
  sessionIds: z.array(workspaceIdSchema).max(200),
  projectId: workspaceIdSchema.nullable(),
  pinned: z.boolean(),
  /** False for a work whose content is owned upstream; PATCH answers READ_ONLY_RESOURCE. */
  editable: z.boolean(),
  cwd: z.string().max(4096),
  agentProvider,
  mirroredDoc: workspaceLinkedDocumentSchema.optional(),
}).meta({ description: 'Work metadata without the content. Read an individual work for its content.', examples: [workExample] })
export type WorkspaceWorkSummary = z.infer<typeof workspaceWorkSummarySchema>

const workspaceUserSchema = z.strictObject({
  id: z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('account'), accountId: z.string().max(256) }),
    z.strictObject({ kind: z.literal('local'), localId: z.string().max(256) }),
    z.strictObject({ kind: z.literal('guest'), guestId: z.string().max(256) }),
  ]),
  displayName: z.string().max(500),
  email: z.string().max(500).optional(),
  avatarUrl: z.string().max(2048).optional(),
})

export const workspaceAttributionSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('user'), user: workspaceUserSchema }),
  z.strictObject({ kind: z.literal('agent'), sessionId: z.string().max(256), provider: agentProvider.optional(), title: z.string().max(500).optional(), for: workspaceUserSchema.optional() }),
  z.strictObject({ kind: z.literal('automation'), automationId: z.string().max(256), name: z.string().max(500).optional(), for: workspaceUserSchema.optional() }),
  z.strictObject({ kind: z.literal('upstream'), provider: z.enum(['gdrive', 'confluence', 'github', 'jira']) }),
  z.strictObject({ kind: z.literal('system') }),
]).meta({ description: 'Who did something: a person, an agent\'s session and the person it worked for, an automation, an upstream system, or Solus itself.' })

export const workspaceWorkSchema = workspaceWorkSummarySchema.extend({
  content: z.string().max(4000000),
  contentVersion: z.number().int().min(0).meta({ description: 'The body\'s version. It advances once per accepted content change; equal content and metadata-only changes do not advance it. The record `version` (If-Match) covers the whole record and is not a content version or a history id.' }),
  contentHash: z.string().max(128).meta({ description: 'SHA-256 of `content`. Identifies identical bodies; it does not replace the `contentVersion` precondition.' }),
  contentAuthor: workspaceAttributionSchema.nullable().meta({ description: 'Who wrote the current body. Null is a body written before authors were recorded.' }),
})
  .meta({ description: 'Preserve existing ownership, parent-access and sharing rules. Organization membership alone does not bypass resource access.', examples: [{ ...workExample, content: '# API notes\nReview the contract.', contentVersion: 1, contentHash: 'a3f1c0de', contentAuthor: null }] })
export type WorkspaceWork = z.infer<typeof workspaceWorkSchema>

export const workspaceCreateWorkSchema = z.strictObject({
  id: workspaceIdSchema.optional(),
  title: z.string().min(1).max(500),
  type: workType,
  content: z.string().max(4000000),
  agentProvider: agentProvider.optional(),
  projectKey: nullableText(4096).optional(),
  projectId: workspaceIdSchema.nullable().optional(),
  originSessionId: workspaceIdSchema.nullable().optional(),
}).meta({ examples: [{ title: 'API notes', type: 'doc', content: '# API notes' }] })
export type WorkspaceCreateWork = z.infer<typeof workspaceCreateWorkSchema>

export const workspaceImportWorkSchema = z.strictObject({
  /** A Confluence page or Google Doc the caller's own account connection can read. */
  url: z.url().max(4096),
  projectKey: nullableText(4096).optional(),
  originSessionId: workspaceIdSchema.nullable().optional(),
}).meta({ description: 'Imports an upstream document as a work linked to its source, read with the caller\'s own account connection. An agent run\'s credential uses its person\'s connection for that run.', examples: [{ url: 'https://example.atlassian.net/wiki/spaces/ENG/pages/1/Plan' }] })
export type WorkspaceImportWork = z.infer<typeof workspaceImportWorkSchema>

export const workspacePublishWorkSchema = z.strictObject({
  /** The provider and destination of a first publish: `confluence` with a space key, or `gdrive` with a folder id. */
  provider: z.string().min(1).max(64).optional(),
  scope: z.string().min(1).max(1024).optional(),
  /** Publish over an upstream change the person decided to discard. */
  overwrite: z.boolean().optional(),
}).meta({ description: 'Publishes the work to its linked upstream document with the caller\'s own account connection, or creates that document on the first publish.', examples: [{ provider: 'confluence', scope: 'ENG' }] })
export type WorkspacePublishWork = z.infer<typeof workspacePublishWorkSchema>

export const workspaceWorkUpstreamSchema = z.strictObject({
  /** `conflict`: the upstream document changed since Solus last saw it; nothing was written. */
  outcome: z.enum(['published', 'conflict', 'pulled']),
  title: z.string().max(500),
  url: z.string().max(4096),
  /** What the conversion could not carry, such as an embedded diagram. */
  lossyParts: z.array(z.string().max(500)).max(50),
}).meta({ examples: [{ outcome: 'published', title: 'API notes', url: 'https://example.atlassian.net/wiki/spaces/ENG/pages/1', lossyParts: [] }] })
export type WorkspaceWorkUpstream = z.infer<typeof workspaceWorkUpstreamSchema>

export const workspaceRequestWorkReviewSchema = z.strictObject({
  /** Members of the work's organization, by user id. A member who cannot open the work is given it as a commenter. */
  reviewerIds: z.array(workspaceIdSchema).min(1).max(50),
  message: z.string().max(2000).optional(),
  expectedContentVersion: z.number().int().min(0).meta({ description: 'The `contentVersion` of the body the reviewers are asked about. A request against a later body is refused with STALE_VERSION.' }),
  requestId: z.string().min(1).max(128).optional().meta({ description: 'Names this request. A retry with the same id notifies no reviewer twice; omit it or send a new one to ask again.' }),
}).meta({ description: 'Asks members to review the work as it is at `expectedContentVersion`. Review is information only: it blocks nothing.', examples: [{ reviewerIds: ['user_123'], message: 'Please check the rollout plan.', expectedContentVersion: 4 }] })
export type WorkspaceRequestWorkReview = z.infer<typeof workspaceRequestWorkReviewSchema>

export const workspaceWorkReviewSchema = z.strictObject({
  state: z.enum(['draft', 'in_review', 'changes_requested', 'approved']),
  reviewers: z.array(z.strictObject({
    reviewerId: z.string().max(256),
    displayName: z.string().max(200),
    decision: z.enum(['approved', 'changes_requested', 'commented']).nullable(),
    /** The decision applies to an earlier body and does not count in `state`. */
    isStale: z.boolean(),
    isAwaiting: z.boolean(),
  })).max(200),
}).meta({ examples: [{ state: 'in_review', reviewers: [{ reviewerId: 'user_123', displayName: 'Alice', decision: null, isStale: false, isAwaiting: true }] }] })
export type WorkspaceWorkReview = z.infer<typeof workspaceWorkReviewSchema>

export const workspaceUpdateWorkSchema = z.strictObject({
  title: z.string().min(1).max(500).optional(),
  content: z.string().max(4000000).optional(),
  expectedContentVersion: z.number().int().min(0).optional().meta({ description: 'The `contentVersion` the writer read, checked with If-Match in one transaction. A write against a later body is refused with STALE_VERSION. Required with `content`; a title-only write may omit it.' }),
}).refine(value => value.title !== undefined || value.content !== undefined, 'At least one of title or content is required.')
  .meta({ description: 'Cannot change type, owner, organization or upstream read-only status. Provider refresh/publish operations remain on their existing path.', minProperties: 1 })
export type WorkspaceUpdateWork = z.infer<typeof workspaceUpdateWorkSchema>

export const workspaceWorkSearchResultSchema = z.strictObject({
  items: z.array(z.strictObject({
    id: workspaceIdSchema,
    title: z.string().max(500),
    type: workType,
    updatedAt: datetime,
    /** The matching passage, on one line. */
    snippet: z.string().max(2000),
  })).max(20),
}).meta({ description: 'The works the caller may open whose title or content matches, most relevant first. Access is checked for every hit; no cursor.', examples: [{ items: [{ id: 'work_example', title: 'API notes', type: 'doc', updatedAt: '2026-09-28T16:00:00Z', snippet: 'Review the API contract' }] }] })
export type WorkspaceWorkSearchResult = z.infer<typeof workspaceWorkSearchResultSchema>

export const workspaceWorkPageSchema = page(workspaceWorkSummarySchema)
export type WorkspaceWorkPage = z.infer<typeof workspaceWorkPageSchema>

// Stored sessions

export const workspaceSessionSchema = z.strictObject({
  ...record,
  provider: agentProvider,
  /** The derived name; `customTitle` is the user's own. */
  title: nullableText(500),
  customTitle: nullableText(500),
  projectId: workspaceIdSchema.nullable(),
  projectPath: z.string().max(4096),
  projectRemote: nullableText(4096),
  runnerHostId: workspaceIdSchema.nullable(),
  status: z.enum(['idle', 'running', 'interrupted']),
  model: nullableText(256),
  reasoningEffort: z.enum(['none', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra', 'ultracode']).nullable(),
  parentSessionId: workspaceIdSchema.nullable(),
  rootSessionId: workspaceIdSchema.nullable(),
  publication: z.enum(['local', 'published']),
  /** Transcript bytes as last reported; zero means no stored text. */
  size: z.number().int().min(0),
  /** The working directory on the runner, which a resume needs. Null until the runner reports it. */
  cwd: nullableText(4096),
  /** The provider's own name for the session, when it gave one. */
  slug: nullableText(500),
  isWorktree: z.boolean(),
  branch: nullableText(256),
  /** The git root that groups a repository with its worktrees, on the runner. */
  projectRoot: nullableText(4096),
  /** How the parent session started this one. Null for a session nobody delegated. */
  delegation: z.strictObject({
    messageId: z.string().max(256),
    depth: z.number().int().min(0),
    intent: z.enum(['delegate', 'fire_and_forget']),
    createdAt: z.number().int().min(0),
  }).nullable(),
}).meta({ description: 'Storage and organization do not grant visibility. Explicit sharing or a verified parent relationship may grant access. `updatedAt` is the last activity.', examples: [{ id: 'session_example', home: { kind: 'organization', serviceId: 'api_example', organizationId: 'org_example' }, organizationId: 'org_example', ownerUserId: 'user_example', version: 'v1-example', createdAt: '2026-09-28T16:00:00Z', updatedAt: '2026-09-28T16:00:00Z', provider: 'codex', title: 'Review the API', customTitle: null, projectId: 'project_example', projectPath: 'project-example', projectRemote: null, runnerHostId: 'host_example', status: 'idle', model: null, reasoningEffort: null, parentSessionId: null, rootSessionId: null, publication: 'published', size: 0, cwd: '/home/example/project', slug: null, isWorktree: false, branch: 'main', projectRoot: '/home/example/project', delegation: null }] })
export type WorkspaceSession = z.infer<typeof workspaceSessionSchema>

export const workspaceSessionAdmissionRequestSchema = z.strictObject({
  sessionId: workspaceIdSchema,
}).meta({ description: 'The Solus session id of the run the credential was issued for. Any other id is refused.', examples: [{ sessionId: 'session_example' }] })
export type WorkspaceSessionAdmissionRequest = z.infer<typeof workspaceSessionAdmissionRequestSchema>

export const workspaceSessionAdmissionSchema = z.strictObject({
  sessionId: workspaceIdSchema,
  organizationId: workspaceIdSchema,
  ownerUserId: workspaceIdSchema,
  hostId: workspaceIdSchema,
  admittedAt: datetime,
}).meta({ description: 'The durable acceptance of a new organization session before its provider starts. The owner is the person whose run authority asked; the execution host reports the session record under this admission. Repeating the request answers the same admission.', examples: [{ sessionId: 'session_example', organizationId: 'org_example', ownerUserId: 'user_example', hostId: 'host_example', admittedAt: '2026-09-28T16:00:00Z' }] })
export type WorkspaceSessionAdmission = z.infer<typeof workspaceSessionAdmissionSchema>

/** True while a machine's first index sweep runs: what it answers is not every session yet. Always false on the workspace service. */
const indexing = z.boolean().meta({ description: 'True while the host is still reading its sessions into its index for the first time. The answer is then incomplete; ask again later.' })

export const workspaceSessionPageSchema = page(workspaceSessionSchema).extend({ indexing })
export type WorkspaceSessionPage = z.infer<typeof workspaceSessionPageSchema>

const workspaceSessionSearchHitSchema = z.strictObject({
  /** The matching passage on one line, each matched word between the markers of `search-snippet.ts`. */
  snippet: z.string().max(2000),
  timestamp: z.number().int().min(0),
  /** The matching message's position in this home's transcript store. */
  messageId: z.number().int().min(0),
  /** Lower is a better match. Comparable only within one answer. */
  rank: z.number(),
})

export const workspaceSessionSearchResultSchema = z.strictObject({
  items: z.array(workspaceSessionSearchHitSchema.partial({ snippet: true, messageId: true }).extend({
    session: workspaceSessionSchema,
    additionalMatches: z.array(workspaceSessionSearchHitSchema).max(2),
  })).max(50),
  /** How many sessions match in all; `items` is the page after the query's `offset`. */
  total: z.number().int().min(0),
  indexing,
}).meta({ description: 'The sessions the caller may open that match, best match first, one page at a time, with up to three passages each. A session that matched by its name alone has no passage. Access is checked for every hit.' })
export type WorkspaceSessionSearchResult = z.infer<typeof workspaceSessionSearchResultSchema>

export const workspaceTranscriptPartSchema = z.strictObject({
  messageId: workspaceIdSchema,
  role: z.enum(['user', 'assistant', 'system', 'tool']),
  timestamp: datetime,
  content: z.string().max(65536),
  contentOffset: z.number().int().min(0),
  isLastPart: z.boolean(),
  toolName: nullableText(256),
  parentToolUseId: workspaceIdSchema.nullable(),
}).meta({ description: 'A stored text message or consecutive fragment. contentOffset is a zero-based Unicode code-point offset. Adjacent parts reconstruct the message exactly. This text projection does not include provider payloads, tool inputs or attachment bytes.' })
export type WorkspaceTranscriptPart = z.infer<typeof workspaceTranscriptPartSchema>

export const workspaceTranscriptPageSchema = page(workspaceTranscriptPartSchema)
  .meta({ description: 'Chronological stored text, ordered by persisted message sequence then content offset. At most 200 parts per page; messages appended later follow on the next page.', examples: [{ items: [{ messageId: 'message_example', role: 'user', timestamp: '2026-09-28T16:00:00Z', content: 'Review the API.', contentOffset: 0, isLastPart: true, toolName: null, parentToolUseId: null }], nextCursor: null }] })
export type WorkspaceTranscriptPage = z.infer<typeof workspaceTranscriptPageSchema>

// Insights

export const workspaceInsightWindowSchema = z.strictObject({ since: datetime, until: datetime })
  .meta({ description: 'Effective startedAt range, inclusive since and exclusive until. Fixed across pages; at most 31 days.' })
export type WorkspaceInsightWindow = z.infer<typeof workspaceInsightWindowSchema>

const insightAttributeValueSchema = z.union([z.string(), z.number(), z.boolean()])
export const workspaceInsightAttributesSchema = z.record(z.string().max(128), insightAttributeValueSchema)
  .meta({ description: "The turn's recorded attributes: counts, timings, tokens, and short labels. The prompt is cut to 200 characters; the system prompt and response are not present. The turn's tree has every attribute." })

export const workspaceInsightSchema = z.strictObject({
  id: z.string().min(1).max(1024),
  traceId: workspaceIdSchema,
  sessionId: workspaceIdSchema.nullable(),
  hostId: workspaceIdSchema,
  userId: workspaceIdSchema.nullable(),
  userEmail: z.email().max(320).nullable(),
  provider: nullableText(64),
  model: nullableText(256),
  startedAt: datetime,
  endedAt: datetime.nullable(),
  durationMs: z.number().int().min(0),
  status: z.string().max(64),
  costUsd: z.number().min(0).nullable(),
  inputTokens: z.number().int().min(0).nullable(),
  outputTokens: z.number().int().min(0).nullable(),
  name: z.string().max(256),
  service: z.string().max(128),
  origin: nullableText(64),
  projectRoot: nullableText(4096),
  attrs: workspaceInsightAttributesSchema,
}).meta({ description: 'One agent-turn observation, identified by an opaque host-and-trace ID within the verified organization. Organization Insights policy governs both list and individual reads. This does not authorize session transcripts. Unknown costs/tokens are null.', examples: [{ id: 'WyJob3N0X2V4YW1wbGUiLCJ0cmFjZV9leGFtcGxlIl0', traceId: 'trace_example', sessionId: 'session_example', hostId: 'host_example', userId: 'user_example', userEmail: null, provider: 'codex', model: null, startedAt: '2026-09-28T16:00:00Z', endedAt: '2026-09-28T16:00:01Z', durationMs: 1000, status: 'ok', costUsd: null, inputTokens: 120, outputTokens: 60, name: 'turn', service: 'solus.sessions', origin: 'typed', projectRoot: null, attrs: { toolCallCount: 3 } }] })
export type WorkspaceInsight = z.infer<typeof workspaceInsightSchema>

export const workspaceInsightPageSchema = page(workspaceInsightSchema).extend({ window: workspaceInsightWindowSchema })
  .meta({ description: 'Bounded records only. No total count, cost sum, raw SQL or arbitrary aggregation. Stable order: startedAt DESC, hostId DESC, traceId DESC. The window is fixed on the first page.', examples: [{ items: [], nextCursor: null, window: { since: '2026-09-21T16:00:00Z', until: '2026-09-28T16:00:00Z' } }] })
export type WorkspaceInsightPage = z.infer<typeof workspaceInsightPageSchema>

export const workspaceInsightSpanSchema = z.strictObject({
  spanId: workspaceIdSchema,
  parentSpanId: workspaceIdSchema.nullable(),
  traceId: workspaceIdSchema,
  kind: z.string().max(64),
  name: z.string().max(256),
  service: z.string().max(128),
  sessionId: workspaceIdSchema.nullable(),
  provider: nullableText(64),
  model: nullableText(256),
  projectRoot: nullableText(4096),
  origin: nullableText(64),
  userId: workspaceIdSchema.nullable(),
  userEmail: z.email().max(320).nullable(),
  startedAt: z.number().int(),
  endedAt: z.number().int(),
  status: z.string().max(64),
  attrs: workspaceInsightAttributesSchema,
})
export type WorkspaceInsightSpan = z.infer<typeof workspaceInsightSpanSchema>

export const workspaceInsightLogEventSchema = z.strictObject({
  spanId: workspaceIdSchema,
  occurredAt: z.number().int(),
  level: z.enum(['debug', 'info', 'warn', 'error']),
  name: z.string().max(256),
  tag: z.string().max(256),
  file: z.string().max(1024),
  attrs: workspaceInsightAttributesSchema,
})
export type WorkspaceInsightLogEvent = z.infer<typeof workspaceInsightLogEventSchema>

export const workspaceInsightTreeSchema = z.strictObject({
  spans: z.array(workspaceInsightSpanSchema),
  events: z.array(workspaceInsightLogEventSchema),
}).meta({ description: "Every span and log event of one turn in the organization, with all recorded attributes. Times are epoch milliseconds." })
export type WorkspaceInsightTree = z.infer<typeof workspaceInsightTreeSchema>

// Activity (plans/012-user-actor-and-activity.md §5)

export const workspaceActivityListSchema = z.strictObject({
  items: z.array(activitySchema).max(200),
}).meta({ description: 'What happened to records people read: a stop, a decision, a rename, a task change, a mention. Oldest first. Only records the caller may open are answered.', examples: [{ items: [{ id: '01J0000000000000000000000A', subject: { kind: 'work', id: 'work_example' }, at: 1759075200000, by: { kind: 'user', user: { id: { kind: 'account', accountId: 'user_example' }, displayName: 'Alice' } }, kind: 'mentioned', userId: { kind: 'account', accountId: 'user_other' } }] }] })
export type WorkspaceActivityList = z.infer<typeof workspaceActivityListSchema>

// Notifications (plans/015-notifications-hub.md §3)

export const workspaceNotificationPageSchema = z.strictObject({
  items: z.array(hubNotificationSchema).max(100),
  nextCursor: z.string().max(2048).nullable(),
}).meta({ description: "The caller's notifications at this home, newest first. Rows the caller may no longer open are left out before the page is cut." })
export type WorkspaceNotificationPage = z.infer<typeof workspaceNotificationPageSchema>

export const workspaceNotificationCountSchema = z.strictObject({
  unread: z.number().int().min(0),
  isCapped: z.boolean(),
}).meta({ description: 'Unread, unarchived notifications the caller may open. The count stops at its cap.' })

export const workspaceNotificationReadSchema = z.strictObject({ read: z.boolean() })
  .meta({ description: 'Set the read fact. Setting it again keeps the same state; it never touches the archive fact.' })
export type WorkspaceNotificationRead = z.infer<typeof workspaceNotificationReadSchema>

export const workspaceNotificationArchivedSchema = z.strictObject({ archived: z.boolean() })
  .meta({ description: 'Archive or restore. Setting it again keeps the same state; it never touches the read fact.' })
export type WorkspaceNotificationArchived = z.infer<typeof workspaceNotificationArchivedSchema>

export const workspaceNotificationSchema = hubNotificationSchema
