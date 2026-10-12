/**
 * A random id on every page. `crypto.randomUUID` exists only in a secure context,
 * and a guest page served by a host on its LAN address is plain `http:`
 * (docs/plans/host-sharing.md §9.7); `getRandomValues` is everywhere.
 */
export function randomId(): string {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID()
  const bytes = new Uint8Array(16)
  if (globalThis.crypto?.getRandomValues) globalThis.crypto.getRandomValues(bytes)
  else for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256)
  return Array.from(bytes, (value) => value.toString(16).padStart(2, '0')).join('')
}
