import { makeGitHubProvider } from './github/provider'
import type { Provider, ProviderId, RepoRef } from './types'

/**
 * Production code-host providers, mirroring `createBackends()`. GitHub is the
 * only host in v1; the interface is shaped by GitHub's reality and will be
 * adjusted — not frozen — when a second host lands.
 */
export function createProviders(): Map<ProviderId, Provider> {
  return new Map<ProviderId, Provider>([['github', makeGitHubProvider()]])
}

const providers = createProviders()

export function getProvider(id: ProviderId): Provider | undefined {
  return providers.get(id)
}

/** Map a repo's host to a provider id. Returns null when no host matches. */
export function providerIdForHost(host: string): ProviderId | null {
  const h = host.toLowerCase()
  if (h === 'github.com' || h.endsWith('.github.com') || h.startsWith('github.')) return 'github'
  return null
}

/** Resolve the provider that owns a repo, or null when its host is unsupported. */
export function providerForRepo(repo: RepoRef): Provider | null {
  const id = providerIdForHost(repo.host)
  return id ? getProvider(id) ?? null : null
}
