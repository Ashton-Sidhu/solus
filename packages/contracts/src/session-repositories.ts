import { z } from 'zod'

export const SESSION_REPOSITORY_TOKEN_PATH = '/runner/session-repositories/token'
export const SESSION_REPOSITORY_HEAD_PATH = '/runner/session-repositories/head'
export const LIST_MY_SESSIONS_OPERATION_PATH = '/me/sessions'
export const LIST_MY_SESSIONS_PATH = `/v1${LIST_MY_SESSIONS_OPERATION_PATH}`
export const SESSION_TURN_DIFF_OPERATION_PATH = '/sessions/:sessionId/turns/:turnIndex/diff'

export const sessionCloudScopeSchema = z.templateLiteral([
  z.enum(['person', 'organization']), ':', z.string().min(1).max(256).regex(/^[A-Za-z0-9][A-Za-z0-9_.-]*$/),
])
export type SessionCloudScope = z.infer<typeof sessionCloudScopeSchema>
export function parseSessionCloudScope(value: string): { kind: 'person' | 'organization'; id: string } | null {
  const result = sessionCloudScopeSchema.safeParse(value)
  if (!result.success) return null
  if (result.data.startsWith('person:')) return { kind: 'person', id: result.data.slice(7) }
  return { kind: 'organization', id: result.data.slice(13) }
}
export function formatSessionCloudScope(kind: 'person' | 'organization', id: string): SessionCloudScope {
  return sessionCloudScopeSchema.parse(`${kind}:${id}`)
}

const id = z.string().min(1).max(256)
const head = z.string().regex(/^[a-f0-9]{40}$/)
export const sessionRepositoryFactsSchema = z.strictObject({
  head: head.nullable(),
  syncedTurn: z.number().int().min(0),
  lastRunHostId: id.nullable(),
  runningHostId: id.nullable(),
})
export type SessionRepositoryFacts = z.infer<typeof sessionRepositoryFactsSchema>

export const sessionRepositoryTokenRequestSchema = z.strictObject({ hostId: id, sessionId: id, access: z.enum(['read', 'write']) })
export type SessionRepositoryTokenRequest = z.infer<typeof sessionRepositoryTokenRequestSchema>
export const sessionRepositoryTokenResponseSchema = sessionRepositoryFactsSchema.extend({
  repository: z.string().regex(/^session-[a-f0-9]{48}$/),
  remote: z.url(),
  token: z.string(),
  expiresAt: z.iso.datetime({ offset: true }),
  storageScope: z.string().min(1),
})
export type SessionRepositoryTokenResponse = z.infer<typeof sessionRepositoryTokenResponseSchema>
export const sessionRepositoryTokenRefusalSchema = z.strictObject({ code: z.enum(['unauthorized', 'forbidden', 'no_repository', 'storage_unavailable']) })
export type SessionRepositoryTokenRefusal = z.infer<typeof sessionRepositoryTokenRefusalSchema>

export const sessionRepositoryCardSchema = z.strictObject({
  title: z.string().nullable(),
  provider: z.enum(['claude-code', 'codex', 'opencode', 'replay']),
  model: z.string().nullable(),
  repositoryKey: z.string().nullable(),
  branch: z.string().nullable(),
  lastActivityAt: z.number().int().min(0),
})
export type SessionRepositoryCard = z.infer<typeof sessionRepositoryCardSchema>
export const sessionRepositoryHeadRequestSchema = z.discriminatedUnion('event', [
  z.strictObject({ hostId: id, sessionId: id, event: z.literal('running') }),
  z.strictObject({ hostId: id, sessionId: id, event: z.literal('idle') }),
  z.strictObject({ hostId: id, sessionId: id, event: z.literal('pushed'), head, syncedTurn: z.number().int().min(1), card: sessionRepositoryCardSchema }),
])
export type SessionRepositoryHeadRequest = z.infer<typeof sessionRepositoryHeadRequestSchema>
export const sessionRepositoryHeadResponseSchema = sessionRepositoryFactsSchema
export type SessionRepositoryHeadResponse = z.infer<typeof sessionRepositoryHeadResponseSchema>
export const sessionRepositoryHeadRefusalSchema = z.strictObject({ head: head.nullable() })
export type SessionRepositoryHeadRefusal = z.infer<typeof sessionRepositoryHeadRefusalSchema>
export const sessionHeadChangedSchema = sessionRepositoryFactsSchema.extend({ sessionId: id })
export type SessionHeadChanged = z.infer<typeof sessionHeadChangedSchema>
export const listMySessionsResponseSchema = z.strictObject({ items: z.array(z.intersection(sessionRepositoryCardSchema, sessionHeadChangedSchema)) })
export type ListMySessionsResponse = z.infer<typeof listMySessionsResponseSchema>
export const sessionTurnDiffSchema = z.discriminatedUnion('status', [
  z.strictObject({ status: z.literal('available'), patch: z.string() }),
  z.strictObject({ status: z.literal('too-large'), filesChanged: z.number().int().nonnegative(), additions: z.number().int().nonnegative(), deletions: z.number().int().nonnegative() }),
  z.strictObject({ status: z.literal('not-available') }),
])
export type SessionTurnDiff = z.infer<typeof sessionTurnDiffSchema>

/** A prompt is refused after this host's push lost the checked head race. */
export const SESSION_DIVERGED = 'SESSION_DIVERGED' as const
export type SessionPromptRefusalCode = typeof SESSION_DIVERGED
