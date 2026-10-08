import { integrationUrlSchema, type IntegrationAuth, type IntegrationProbeResult } from '@solus/contracts/integration-types'

/** The short label for how an integration authenticates. */
export function authKindLabel(auth: IntegrationAuth): string {
  if (auth.kind === 'none') return 'Open'
  if (auth.kind === 'oauth') return 'Sign-in'
  return 'API key'
}

type UndeterminedReason = Extract<IntegrationProbeResult, { outcome: 'undetermined' }>['reason']

const UNDETERMINED_REASONS = {
  unavailable: 'The server is not available now.',
  unreachable: 'Solus cannot reach this address.',
  timeout: 'The server did not answer in time.',
  redirected: 'This address sends Solus to a different address. Use the final address.',
  refused: 'The server refused the request.',
  not_mcp: 'This address is not an MCP server.',
  initialize_error: 'The server did not start an MCP session.',
  tools_error: 'The server did not list its tools.',
  oauth_unusable: 'The server asks for sign-in, but Solus cannot use its sign-in settings.',
} satisfies { [reason in UndeterminedReason]: string }

export interface ProbeOutcomeText {
  message: string
  /** Add creates the record. True for every outcome except `undetermined`. */
  canAdd: boolean
  /** The outcome can change on a second probe. */
  canRetry: boolean
}

/** What the person reads after a probe, before Add (mcp-integrations.md §3.2). */
export function probeOutcomeText(result: IntegrationProbeResult): ProbeOutcomeText {
  switch (result.outcome) {
    case 'anonymous':
      return { message: `Works without sign-in, ${toolCount(result.tools.length)}`, canAdd: true, canRetry: false }
    case 'oauth':
      return { message: 'Needs sign-in; sign-in arrives in a later release', canAdd: true, canRetry: false }
    case 'credentials-required':
      return { message: 'Needs an API key; API keys arrive in a later release', canAdd: true, canRetry: false }
    case 'undetermined':
      return { message: UNDETERMINED_REASONS[result.reason], canAdd: false, canRetry: true }
  }
}

function toolCount(count: number): string {
  return count === 1 ? '1 tool' : `${count} tools`
}

/** The host part of an integration's address, or the address when it does not parse. */
export function urlHost(url: string): string {
  return URL.canParse(url) ? new URL(url).host : url
}

/** The first non-empty line of a tool description. */
export function firstLine(text: string): string {
  return text.split('\n').map((line) => line.trim()).find((line) => line.length > 0) ?? ''
}

/** Why a typed address cannot be an integration, or null when it can. */
export function customUrlProblem(url: string): string | null {
  if (!url.trim()) return 'Type the address of an MCP server.'
  return integrationUrlSchema.safeParse(url).success ? null : 'Use an HTTPS address with no credentials or fragment.'
}
