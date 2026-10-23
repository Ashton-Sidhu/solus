import { SOLUS_PROTOCOL, SOLUS_PROTOCOL_HEADER } from '@solus/contracts/uplink'
import type { FetchLike } from '../admission/access-tokens'

/**
 * A request to the account plane's `/v1` routes: host link, enrollment, organizations,
 * activity, and a person's account reads. Each names the protocol this server speaks, so
 * an account plane that no longer speaks it answers `update_required` (HTTP 426) instead
 * of misreading the request (docs/plans/simplify-auth-and-sync.md §4.6).
 */
export function fetchAccountPlane(fetchImpl: FetchLike | undefined, url: string | URL, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers)
  headers.set(SOLUS_PROTOCOL_HEADER, String(SOLUS_PROTOCOL))
  return (fetchImpl ?? fetch)(url, { ...init, headers })
}
