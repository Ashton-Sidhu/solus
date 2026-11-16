import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'

/**
 * The signature of a management request (docs/plans/app-deploy.md §5.3). Solus
 * and one deployment share the app key. Solus signs what it asks of the
 * deployment, so the key itself never crosses in that direction, and a request
 * that another party recorded stops working after five minutes.
 *
 * The header is `v1,<seconds>,<hex>`. The signed text is the time, the method,
 * the path with its query, and the SHA-256 of the body, one on each line.
 */

const VERSION = 'v1'
/** How far the clock of the two sides may differ, and how long a recorded request works. */
export const MANAGEMENT_SIGNATURE_WINDOW_MS = 5 * 60_000

export interface SignedRequest {
  method: string
  /** The path with its query, as the request line has it. */
  path: string
  body: Buffer | string
}

/** A new app key: `sak_` and 32 random bytes. */
export function newAppKey(): string {
  return `sak_${randomBytes(32).toString('base64url')}`
}

function mac(key: string, seconds: number, request: SignedRequest): Buffer {
  const bodyHash = createHash('sha256').update(request.body).digest('hex')
  return createHmac('sha256', key).update(`${seconds}\n${request.method.toUpperCase()}\n${request.path}\n${bodyHash}`).digest()
}

export function signManagementRequest(key: string, request: SignedRequest, now = Date.now()): string {
  const seconds = Math.floor(now / 1000)
  return `${VERSION},${seconds},${mac(key, seconds, request).toString('hex')}`
}

/** Whether the header is this request's signature with this key, made in the last five minutes. */
export function verifyManagementRequest(key: string, request: SignedRequest, header: string | undefined, now = Date.now()): boolean {
  const match = /^v1,(\d{1,12}),([a-f0-9]{64})$/.exec(header ?? '')
  if (!match) return false
  const seconds = Number(match[1])
  if (Math.abs(now - seconds * 1000) > MANAGEMENT_SIGNATURE_WINDOW_MS) return false
  return timingSafeEqual(mac(key, seconds, request), Buffer.from(match[2]!, 'hex'))
}
