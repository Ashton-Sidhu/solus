import { z } from 'zod'

/** The largest request body any Solus API route takes: a work's content, with room for its JSON. */
const MAX_BODY_CHARS = 16 * 1024 * 1024 + 64 * 1024
const headerValue = z.string().min(1).max(256)
export const solusApiMethodSchema = z.enum(['GET', 'POST', 'PATCH', 'PUT', 'DELETE'])

/**
 * One Solus API request, as a client sends it over HTTP or over its socket
 * (`solusApiRequest`). It carries no credential: over HTTP the client adds its
 * bearer, and over a socket the socket's principal is its authority.
 */
export const solusApiRequestSchema = z.strictObject({
  method: solusApiMethodSchema,
  /** The route under `/v1`, with its query. */
  path: z.string().max(8192).regex(/^\/[^#]*$/),
  ifMatch: headerValue.optional(),
  ifNoneMatch: headerValue.optional(),
  idempotencyKey: headerValue.optional(),
  /** A JSON body. */
  body: z.string().max(MAX_BODY_CHARS).optional(),
})
export type SolusApiRequest = z.infer<typeof solusApiRequestSchema>

/** The answer to a Solus API request: its status, the headers a client reads, and its body. */
export interface SolusApiResponse {
  status: number
  etag: string | null
  retryAfter: string | null
  body: string
}

/** The HTTP headers a request stands for. */
export function solusApiRequestHeaders(request: SolusApiRequest): Headers {
  const headers = new Headers()
  if (request.body !== undefined) headers.set('Content-Type', 'application/json')
  if (request.ifMatch) headers.set('If-Match', request.ifMatch)
  if (request.ifNoneMatch) headers.set('If-None-Match', request.ifNoneMatch)
  if (request.idempotencyKey) headers.set('Idempotency-Key', request.idempotencyKey)
  return headers
}

export async function solusApiResponseOf(response: Response): Promise<SolusApiResponse> {
  return { status: response.status, etag: response.headers.get('ETag'), retryAfter: response.headers.get('Retry-After'), body: await response.text() }
}
