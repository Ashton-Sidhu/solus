import type { SessionCloudScope } from '@solus/contracts/session-repositories'

/**
 * The place that holds large files that Git must not carry: the code bundles of
 * session repositories (docs/plans/session-storage.md §6). It sits beside
 * `RepositoryProvider`. The Solus API signs a URL for one object, and the host
 * reads or writes the bytes at that URL with no other credential.
 */
export interface ObjectStore {
  /** Identifies the place, as `RepositoryProvider.storageScope` does. */
  readonly storageScope: string
  /**
   * A URL for one object that lasts `OBJECT_URL_TTL_SECONDS`. A `write` URL accepts
   * only `facts.bytes` bytes whose SHA-256 is `facts.sha256`. The URL can be relative
   * to the Solus API.
   */
  signedUrl(key: string, access: 'read' | 'write', facts: { bytes: number; sha256: string }): Promise<string>
}

export const OBJECT_URL_TTL_SECONDS = 900

const SESSION_CODE_KEY = /^sessions\/(?:person|organization):[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*\/[a-f0-9]{64}$/

/** Each key starts with the cloud scope and the session, so a later delete can remove a session by prefix (decision 11). */
export function sessionCodeKey(scope: SessionCloudScope, sessionId: string, sha256: string): string {
  const key = `sessions/${scope}/${sessionId}/${sha256}`
  if (!isSessionCodeKey(key)) throw new Error('Invalid session code key.')
  return key
}

export function isSessionCodeKey(key: string): boolean {
  return SESSION_CODE_KEY.test(key)
}

/** RFC 3986 encoding, as S3 signatures need it. A local URL uses the same encoding. */
export function encodeUriPart(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, character => `%${character.charCodeAt(0).toString(16).toUpperCase()}`)
}

export function encodeObjectKey(key: string): string {
  return key.split('/').map(encodeUriPart).join('/')
}
