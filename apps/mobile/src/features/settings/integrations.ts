import type {
  CatalogEntry,
  Integration,
  IntegrationAuth,
  IntegrationProbeResult,
  IntegrationToolSummary,
} from '@solus/contracts/integration-types'

/**
 * The integrations of one host (docs/plans/mcp-integrations.md §7), as the
 * mobile Integrations screen shows them: the list, the tools of the ones the
 * person opened, and the add flow (catalog search or a custom URL, then the
 * probe result before Add). Phase 1 has anonymous MCP servers only; a server
 * that needs sign-in can be added, and its sign-in arrives in a later release.
 */

export type IntegrationListState =
  | { kind: 'loading' }
  | { kind: 'loaded'; integrations: Integration[] }
  | { kind: 'error'; message: string }
  /** An older host that has no integration methods. */
  | { kind: 'unsupported' }

export type IntegrationToolsState =
  | { kind: 'loading' }
  | { kind: 'loaded'; tools: IntegrationToolSummary[] }
  | { kind: 'error'; message: string }

export type CatalogState =
  | { kind: 'idle' }
  | { kind: 'loading'; query: string }
  | { kind: 'loaded'; query: string; entries: CatalogEntry[] }
  | { kind: 'error'; query: string; message: string }

/** The server the person chose to add: a catalog entry or a URL they typed. */
export interface IntegrationCandidate {
  name: string
  url: string
  /** The catalog's slug; absent for a custom URL, so the host derives one from the name. */
  slug?: string
}

export type ProbeState =
  | { kind: 'idle' }
  | { kind: 'probing'; url: string }
  | { kind: 'done'; url: string; result: IntegrationProbeResult }
  | { kind: 'error'; url: string; message: string }

/** The one change in flight, so its control shows progress and the others wait. */
export type IntegrationAction = 'create' | `rename:${string}` | `remove:${string}`

export const UNSUPPORTED_NOTE = 'This host does not support integrations. Update Solus on it.'

/** True for the error an older host gives for a method it does not have. */
export function isUnsupportedMethodError(message: string): boolean {
  return /unknown method|no handler for|not registered|not a function/i.test(message)
}

export function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}

/** The list in name order, with `integration` added or replaced. */
export function upsertIntegration(list: readonly Integration[], integration: Integration): Integration[] {
  const others = list.filter((entry) => entry.id !== integration.id)
  return sortIntegrations([...others, integration])
}

export function withoutIntegration(list: readonly Integration[], integrationId: string): Integration[] {
  return list.filter((entry) => entry.id !== integrationId)
}

export function sortIntegrations(list: Integration[]): Integration[] {
  return list.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }))
}

/** How an integration authenticates, in a few words. */
export function authKindLabel(auth: IntegrationAuth): string {
  switch (auth.kind) {
    case 'none': return 'No sign-in'
    case 'oauth': return 'Sign-in'
    case 'bearer': return 'API key'
  }
}

/** What the probe found, and whether the person may add the server now. */
export interface ProbeOutcomeView {
  title: string
  detail?: string
  canAdd: boolean
  canRetry: boolean
}

type UndeterminedReason = Extract<IntegrationProbeResult, { outcome: 'undetermined' }>['reason']

const UNDETERMINED_REASON = {
  unavailable: 'The host cannot check servers now.',
  unreachable: 'The host cannot reach this address.',
  timeout: 'The server did not answer in time.',
  redirected: 'The server sent the request to a different address. Solus does not follow it.',
  refused: 'The server refused the request.',
  not_mcp: 'This address does not answer as an MCP server.',
  initialize_error: 'The server did not start an MCP session.',
  tools_error: 'The server did not send its list of tools.',
  oauth_unusable: 'The server asks for sign-in, but Solus cannot use its sign-in details.',
} satisfies Record<UndeterminedReason, string>

export function probeOutcomeView(result: IntegrationProbeResult): ProbeOutcomeView {
  switch (result.outcome) {
    case 'anonymous':
      return { title: `Works without sign-in, ${toolCount(result.tools.length)}`, canAdd: true, canRetry: false }
    case 'oauth':
    case 'credentials-required':
      return { title: 'Needs sign-in; arrives in a later release', canAdd: true, canRetry: false }
    case 'undetermined':
      return { title: 'Solus could not add this server', detail: UNDETERMINED_REASON[result.reason], canAdd: false, canRetry: true }
  }
}

export function toolCount(count: number): string {
  return count === 1 ? '1 tool' : `${count} tools`
}

/** The first line of a tool's description, for a one-line row. */
export function firstLine(text: string): string {
  return text.trim().split(/\r?\n/, 1)[0]?.trim() ?? ''
}

/**
 * The same rule as `integrationUrlSchema`: an HTTPS address with no
 * credentials, fragment, or placeholder. A query is allowed. Written without `URL`,
 * which React Native implements only in part.
 */
export function isIntegrationUrl(input: string): boolean {
  const value = input.trim()
  if (value.length === 0 || value.length > 4096) return false
  if (/[{}]|%7b|%7d/i.test(value)) return false
  if (/[\s#]/.test(value)) return false
  const match = /^https:\/\/([^/?]*)([/?].*)?$/i.exec(value)
  if (!match) return false
  const authority = match[1]!
  if (authority.includes('@')) return false
  return /^(\[[0-9a-f:.]+\]|[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*)(:\d{1,5})?$/i.test(authority)
}

/** True when the person seems to type an address rather than a search. */
export function looksLikeUrl(input: string): boolean {
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(input.trim())
}

/** The host part of an address, for a one-line row; the address itself when it has none. */
export function urlHost(url: string): string {
  const match = /^[a-z][a-z0-9+.-]*:\/\/(?:[^@/]*@)?([^/:?#]+|\[[^\]]+\])/i.exec(url.trim())
  return match?.[1] ?? url
}

/** A custom URL becomes a candidate named for its host; the person may change the name. */
export function customCandidate(url: string): IntegrationCandidate {
  const trimmed = url.trim()
  return { name: urlHost(trimmed), url: trimmed }
}

export function catalogCandidate(entry: CatalogEntry): IntegrationCandidate {
  return { name: entry.name, url: entry.url, slug: entry.slug }
}
