/**
 * HTTP Basic credentials (RFC 7617) for a server that asks for a user name and
 * a password (`auth.kind: 'bearer'`, `scheme: 'basic'`). The person types the
 * two; the client sends their encoding as the key, and the host and the cloud
 * vault send that key as `Basic <key>`, as they do for a pasted one. Desktop,
 * web, and mobile check and encode the same way.
 */

/** Why the user name cannot be sent, or null when it can. RFC 7617 §2: the user name ends at the first colon. */
export function basicUsernameError(username: string): string | null {
  if (!username) return 'Enter a user name.'
  if (username.includes(':')) return 'A user name cannot contain a colon.'
  return null
}

/** `user-id ":" password` in UTF-8, as Base64: the key that goes after `Basic`. */
export function basicCredentials(username: string, password: string): string {
  const bytes = new TextEncoder().encode(`${username}:${password}`)
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}
