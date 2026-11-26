import { z } from 'zod'
import { agentIdSchema } from './types'

export const SESSION_REPOSITORY_TOKEN_PATH = '/runner/session-repositories/token'
export const SESSION_REPOSITORY_HEAD_PATH = '/runner/session-repositories/head'
export const SESSION_CODE_URL_PATH = '/runner/session-repositories/code'
/**
 * A PUT to a code URL sends this header with the base64 SHA-256 of the body, and a
 * `content-length` of the requested bytes. Both are in the signature, so the store
 * refuses other bytes (docs/plans/session-storage.md §6).
 */
export const SESSION_CODE_CHECKSUM_HEADER = 'x-amz-checksum-sha256'
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

/** `format: 2` tells the API that the host writes manifest version 2. The API refuses a request without it (docs/plans/session-storage.md decision 7). */
export const sessionRepositoryTokenRequestSchema = z.strictObject({ hostId: id, sessionId: id, access: z.enum(['read', 'write']), format: z.literal(2).optional() })
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

/** A signed URL for one code bundle of a session. The session id is one key segment, so it has no `/`. */
export const sessionCodeUrlRequestSchema = z.strictObject({
  hostId: id,
  sessionId: id.regex(/^[A-Za-z0-9][A-Za-z0-9_.-]*$/),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  bytes: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  access: z.enum(['read', 'write']),
})
export type SessionCodeUrlRequest = z.infer<typeof sessionCodeUrlRequestSchema>
/** `url` can be relative to the Solus API. */
export const sessionCodeUrlResponseSchema = z.strictObject({ url: z.string().min(1), expiresAt: z.iso.datetime({ offset: true }) })
export type SessionCodeUrlResponse = z.infer<typeof sessionCodeUrlResponseSchema>

export const sessionRepositoryCardSchema = z.strictObject({
  title: z.string().nullable(),
  provider: agentIdSchema,
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
