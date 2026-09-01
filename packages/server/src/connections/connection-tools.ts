import { z } from 'zod'
import {
  CONNECTION_LABELS,
  CONNECTION_PROVIDERS,
  isConnectionProvider,
} from '@solus/contracts/connections'
import type { ConnectionConnectNeeded, ConnectionProvider, ConnectionReason } from '@solus/contracts/connections'
import type { AgentTool } from '../agents/tools/agent-tool'
import { loadToken as loadCloudflareToken } from '../cloudflare/token-store'
import { loadCredential as loadAtlassianCredential } from '../atlassian/token-store'
import { isOAuthConfigured as isAtlassianOAuthConfigured } from '../atlassian/oauth'
import { GitHubAuth } from '../providers/github/auth'
import { getAccessToken as getGoogleAccessToken, isGoogleOAuthConfigured } from '../google/oauth'

/**
 * One tool for every external account, because the work is the same in every
 * case: report whether Solus can reach the account, and if it cannot, raise the
 * interrupt that asks the user to connect it.
 *
 * Never returns a credential — only whether one exists and the metadata the
 * user would recognize. Connecting is the user's act, in the card.
 */

let notifyConnectNeeded: ((request: ConnectionConnectNeeded) => void) | null = null

export function setConnectionConnectNeededListener(
  listener: (request: ConnectionConnectNeeded) => void,
): void {
  notifyConnectNeeded = listener
}

interface ConnectionState {
  connected: boolean
  /** What the user would recognize the account by — never a credential. */
  account?: string
  /** `env` means the machine supplied it and Solus cannot revoke it. */
  source?: 'env' | 'stored'
  /** Set when the build itself cannot connect this provider. */
  unavailableReason?: string
}

async function cloudflareState(): Promise<ConnectionState> {
  if (process.env.CLOUDFLARE_API_TOKEN) return { connected: true, source: 'env' }
  const token = loadCloudflareToken()
  if (!token) return { connected: false }
  const state: ConnectionState = { connected: true, source: 'stored' }
  if (token.accountName) state.account = token.accountName
  return state
}

async function atlassianState(): Promise<ConnectionState> {
  const credential = loadAtlassianCredential()
  if (credential) {
    return { connected: true, source: 'stored', account: credential.siteName ?? credential.siteUrl }
  }
  if (!isAtlassianOAuthConfigured()) {
    return { connected: false, unavailableReason: 'This build ships no Atlassian OAuth client.' }
  }
  return { connected: false }
}

async function githubState(): Promise<ConnectionState> {
  const status = await new GitHubAuth().status()
  if (!status.connected) return { connected: false }
  const state: ConnectionState = { connected: true, source: 'stored' }
  if (status.login) state.account = status.login
  return state
}

async function googleState(): Promise<ConnectionState> {
  // A build with no OAuth client cannot connect at all, which is a different
  // answer from "not connected yet" — raising a card here would offer the user
  // a button that provably cannot work.
  if (!isGoogleOAuthConfigured()) {
    return { connected: false, unavailableReason: 'This build ships no Google OAuth client.' }
  }
  return { connected: !!(await getGoogleAccessToken()), source: 'stored' }
}

const PROVIDER_STATE: Record<ConnectionProvider, () => Promise<ConnectionState>> = {
  cloudflare: cloudflareState,
  github: githubState,
  atlassian: atlassianState,
  google: googleState,
}

/**
 * Confluence and Jira are the same Atlassian grant, so both resolve to one
 * provider and differ only in the reason the card shows. An agent asked to "set
 * up Jira" must not answer with a word the user did not use.
 */
const REASON_PROVIDER: Record<ConnectionReason, ConnectionProvider | null> = {
  deploy: 'cloudflare',
  'pull-requests': 'github',
  issues: 'github',
  confluence: 'atlassian',
  jira: 'atlassian',
  drive: 'google',
  unspecified: null,
}

const connectionStatusArgsSchema = z.object({
  provider: z.string().optional(),
  reason: z.string().optional(),
})

function isConnectionReason(value: string): value is ConnectionReason {
  return Object.hasOwn(REASON_PROVIDER, value)
}

function resolveTarget(
  provider: string | undefined,
  reason: string | undefined,
): { provider: ConnectionProvider; reason: ConnectionReason } | null {
  const namedReason = reason && isConnectionReason(reason) ? reason : 'unspecified'
  if (provider && isConnectionProvider(provider)) {
    return { provider, reason: namedReason }
  }
  // A reason alone is enough: "set up Jira" names the product, not the account.
  const fromReason = REASON_PROVIDER[namedReason]
  return fromReason ? { provider: fromReason, reason: namedReason } : null
}

export const connectionStatusAgentTool: AgentTool = {
  name: 'connection_status',
  description:
    'Check whether Solus can reach an external account — cloudflare, github, atlassian (Confluence and Jira share one Atlassian connection), or google. Returns connection metadata only, never a credential. When the account is not connected, this asks the user to connect it and they answer in the conversation; do not ask for a token or a password yourself. Pass `reason` to say what the connection is for: deploy, pull-requests, issues, confluence, jira, drive.',
  // Both optional, and either one is enough to identify the account: "set up
  // Jira" names a product, not a provider. Requiring both would reject the call
  // the description invites.
  inputFields: {
    provider: z.string().optional()
      .describe(`One of: ${CONNECTION_PROVIDERS.join(', ')}. Optional when reason names one.`),
    reason: z.string().optional()
      .describe('What the connection is for: deploy, pull-requests, issues, confluence, jira, drive.'),
  } as const,
  requiresApproval: false,
  execute: async (input, context) => {
    const args = connectionStatusArgsSchema.safeParse(input)
    if (!args.success) return { ok: false, text: '`provider` and `reason` must be strings.' }

    const target = resolveTarget(args.data.provider, args.data.reason)
    if (!target) {
      return {
        ok: false,
        text: `Name the account to check: ${CONNECTION_PROVIDERS.join(', ')}. Confluence and Jira are both 'atlassian'.`,
      }
    }

    const state = await PROVIDER_STATE[target.provider]()
    if (state.connected) {
      return { ok: true, text: JSON.stringify({ provider: target.provider, ...state }) }
    }

    // A build that cannot connect this provider gets no card: offering a button
    // that provably fails is worse than saying so plainly.
    if (state.unavailableReason) {
      return {
        ok: true,
        text: JSON.stringify({ provider: target.provider, connected: false, askedUser: false, note: state.unavailableReason }),
      }
    }

    // The turn is waiting on a person now, so the card goes up beside the
    // conversation that asked. A run with no session behind it has nowhere to
    // put it and simply reports the gap.
    const sessionId = context.solusSessionId()
    if (sessionId) {
      notifyConnectNeeded?.({ provider: target.provider, reason: target.reason, sessionId })
    }
    return {
      ok: true,
      text: JSON.stringify({
        provider: target.provider,
        connected: false,
        askedUser: !!sessionId,
        note: sessionId
          ? `Asked the user to connect ${CONNECTION_LABELS[target.provider]}. Wait for them; do not request a credential in the conversation.`
          : `${CONNECTION_LABELS[target.provider]} is not connected, and there is no conversation to ask in.`,
      }),
    }
  },
}
