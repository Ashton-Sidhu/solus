import type { ProjectIdentity, Session } from '../../../shared/types'

export function isRunOnHostLocked(session: Session | undefined): boolean {
  if (!session) return true
  return session.agentSessionId !== null || session.messages.length > 0 || session.status !== 'idle'
}

export function repoKeyForPath(identities: ProjectIdentity[], path: string | null | undefined): string | null {
  if (!path || path === '~') return null
  return identities.find((identity) => identity.path === path)?.repoKey ?? null
}

export function checkoutForRepo(identities: ProjectIdentity[], repoKey: string | null): ProjectIdentity | null {
  if (!repoKey) return null
  const normalizedRepoKey = repoKey.toLowerCase()
  return identities.find((identity) => identity.repoKey.toLowerCase() === normalizedRepoKey) ?? null
}
