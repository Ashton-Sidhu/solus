import { solusApiOperations } from './operations'

/**
 * The paths the record service answers when it shares an origin with the account
 * site (plans/013-unified-cloud-application.md §4, "Route ownership"). The cloud
 * application dispatches on this before any handler reads the request body.
 *
 * Under `/v1` the record service owns the first segment of every operation in the
 * registry. Outside it, it owns the live transport, the ticket and token doors, the
 * runner delivery routes, signed assets and uploads, and its health probe. Matching
 * is by whole segment: `/wsx` and `/runners` are not record paths.
 */
const RECORD_V1_SEGMENTS: ReadonlySet<string> = new Set(
  Object.values(solusApiOperations).map(operation => operation.path.split('/')[1]),
)
const RECORD_PATHS: ReadonlySet<string> = new Set(['/health', '/auth/ws-ticket', '/auth/refresh', '/auth/revoke'])
const RECORD_PATH_ROOTS = ['/ws', '/runner', '/api/assets', '/api/uploads'] as const

export function isRecordServicePath(pathname: string): boolean {
  if (RECORD_PATHS.has(pathname)) return true
  if (RECORD_PATH_ROOTS.some(root => pathname === root || pathname.startsWith(root + '/'))) return true
  if (!pathname.startsWith('/v1/')) return false
  return RECORD_V1_SEGMENTS.has(pathname.slice(4).split('/')[0])
}
