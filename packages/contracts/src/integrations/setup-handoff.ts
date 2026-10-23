import type { IntegrationProbeUndeterminedReason } from '../integration-types'

/**
 * "Set up with an agent" (docs/plans/mcp-integrations.md §13.4): when Solus
 * cannot connect a server by itself, an agent finds what the person must set
 * up at the vendor. One module, so the connect dialog on every client and the
 * `connect_integration` tool give the same steps.
 */

/** What the person must set up before Solus can connect. */
export type IntegrationSetupNeed = 'api-key' | 'oauth-client' | 'endpoint'

/**
 * Probe results whose cause an agent can find in the vendor's documentation:
 * a wrong or private address, a sign-in Solus cannot use, or an address that
 * is not the MCP endpoint. Unavailable, timeout, unreachable, and redirected
 * are answered with Retry or with the address the server named.
 */
const ENDPOINT_REASONS: readonly IntegrationProbeUndeterminedReason[] = ['refused', 'oauth_unusable', 'not_mcp']

/** The setup a probe that decided nothing calls for, or null when a retry is the answer. */
export function setupNeedOfUndetermined(reason: IntegrationProbeUndeterminedReason): IntegrationSetupNeed | null {
  return ENDPOINT_REASONS.includes(reason) ? 'endpoint' : null
}

export interface IntegrationSetupTarget {
  name: string
  url: string
  /** The callback address to register for an OAuth client. Absent where the caller cannot know the person's origin. */
  callbackUrl?: string
  /** The vendor's own setup page, from the Solus catalog's `authHelp` (§13.5). */
  guideUrl?: string
}

/** One "Set up with an agent" hand-off: what the person must set up, for which server. */
export class SetupHandoff {
  constructor(readonly need: IntegrationSetupNeed, private readonly target: IntegrationSetupTarget) {}

  /** What to find, as steps an agent can follow. Never asks for the secret itself. */
  get steps(): string {
    const { guideUrl } = this.target
    return guideUrl ? `${this.findSteps} Start from the vendor's setup page: ${guideUrl}.` : this.findSteps
  }

  /** The line beside the "Set up with an agent" button. */
  get hint(): string {
    switch (this.need) {
      case 'api-key': return 'An agent can find how to create the key.'
      case 'oauth-client': return 'An agent can find how to create the client.'
      case 'endpoint': return 'An agent can find the right address in the vendor\u2019s docs.'
    }
  }

  /** The prompt of the conversation "Set up with an agent" opens. */
  get prompt(): string {
    const { name, url } = this.target
    const finish = this.need === 'endpoint'
      ? 'When you find the right URL, tell me, and I add it in Settings → MCP.'
      : `When I have it, I enter it in Settings → MCP, or you call connect_integration for ${name}.`
    return [
      `Help me connect ${name} (${url}) to Solus as an MCP integration.`,
      this.steps,
      'Do not ask me for a key, a token, a client secret, or a password in this conversation.',
      finish,
    ].join('\n\n')
  }

  private get findSteps(): string {
    const { name, url, callbackUrl } = this.target
    switch (this.need) {
      case 'api-key':
        return `${name} signs in with an API key. Find, in ${name}'s own documentation, where it issues API keys and the exact steps to create one, and which permissions the key needs.`
      case 'oauth-client': {
        const callback = callbackUrl
          ? `Register this callback URL on the client: ${callbackUrl}.`
          : 'Register the callback URL that Solus shows in the connect card.'
        return `${name} needs an OAuth client that the user creates at ${name}. Find ${name}'s OAuth app settings and the exact steps to create a client. ${callback} Say which scopes to choose.`
      }
      case 'endpoint':
        return `Solus could not connect to ${url}. Read ${name}'s documentation to find its remote MCP server URL and how it signs in.`
    }
  }
}
