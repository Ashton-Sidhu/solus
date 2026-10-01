import type { CheckoutStep } from '../../../contexts/workspace/repository-checkout'

/** The name a person knows a repository by: `github.com/acme/web` is `web`. */
export function repositoryName(repositoryKey: string): string {
  return repositoryKey.split('/').filter(Boolean).at(-1) ?? repositoryKey
}

/**
 * What the repository stage says while Start prepares the repository. A
 * stopped cloud host is started, which takes minutes, so that wait is named
 * apart from a connection that takes a moment.
 */
export function repositoryPreparationTitle(
  step: CheckoutStep,
  repositoryKey: string,
  hostLabel: string,
  hostIsStarting: boolean,
): string {
  if (step === 'cloning') return `Cloning ${repositoryName(repositoryKey)} on ${hostLabel}`
  return hostIsStarting ? `Starting ${hostLabel}` : `Connecting to ${hostLabel}`
}
