import { GITHUB_CONNECTION_REQUIRED_CODE } from '@solus/contracts/providers'

/**
 * A clone failed on a host that clones with the account's GitHub connection,
 * and the account has none (docs/plans/cloud-onboarding.md §9). The code lets
 * the client offer the account's Connections page instead of the git error.
 */
export class GithubConnectionRequiredError extends Error {
  readonly code = GITHUB_CONNECTION_REQUIRED_CODE

  constructor() {
    super('GitHub is not connected to your Solus account, so this host cannot clone the repository. Connect GitHub, then send again.')
    this.name = 'GithubConnectionRequiredError'
  }
}
