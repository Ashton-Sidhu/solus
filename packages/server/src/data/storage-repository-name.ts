import { createHash } from 'node:crypto'

/**
 * The name of a Git storage repository (docs/adr/0004-shared-git-storage.md):
 * one bare repository for each work and for each session, on a host and in
 * cloud storage. A record keeps the name, so the rule must never change: a
 * different name loses the history that is in the repository.
 */

/** The feature that owns a storage repository; it is the first part of the name. */
export type StorageRepositoryKind = 'work' | 'session'

/** `owner` is what holds the item (an organization id or a cloud scope) and `id` is the item (a work id or a session id). */
export function storageRepositoryName(kind: StorageRepositoryKind, owner: string, id: string): string {
  return `${kind}-${createHash('sha256').update(JSON.stringify([owner, id])).digest('hex').slice(0, 48)}`
}

/** With no `kind`, a name of each feature is valid. */
export function isStorageRepositoryName(name: string, kind?: StorageRepositoryKind): boolean {
  const match = /^(work|session)-[a-f0-9]{48}$/.exec(name)
  return match !== null && (kind === undefined || match[1] === kind)
}
