import { CONNECTION_LABELS } from '@solus/contracts/connections'
import type { ConnectionProvider, ConnectionReason } from '@solus/contracts/connections'
import type { ConnectRequest } from '../../../contexts/connections/connect-request.store.svelte'

/**
 * What a row of the connect card says. Kept out of the component because it is a table, not
 * markup, and because the reason — not the provider — is what the user
 * recognizes: someone who asked to "set up Jira" should not be answered with
 * the word "Atlassian" alone.
 */

export interface ConnectCardCopy {
  /** The product the user named, which may not be the account's name: the row's title. */
  name: string
  /** The account's own name, for the continue prompt. */
  providerLabel: string
  /** One line on why this is being asked for now: the row's detail line. */
  purpose: string
  /** Present when one account serves more than the product the user named. */
  note?: string
}

const PURPOSE = {
  'pull-requests': 'Needed to read and write pull requests on your behalf.',
  issues: 'Needed to read and write issues on your behalf.',
  confluence: 'Needed to read and publish Confluence pages.',
  jira: 'Needed to read and update Jira issues.',
  drive: 'Needed to read and write your Google Docs.',
  unspecified: 'Needed to continue.',
} satisfies Record<ConnectionReason, string>

/** The product the reason names, where it differs from the account being connected. */
const PRODUCT_NAME = {
  'pull-requests': null,
  issues: null,
  confluence: 'Confluence',
  jira: 'Jira',
  drive: null,
  unspecified: null,
} satisfies Record<ConnectionReason, string | null>

export function connectCardCopy(
  provider: ConnectionProvider,
  reason: ConnectionReason,
): ConnectCardCopy {
  const label = CONNECTION_LABELS[provider]
  const copy: ConnectCardCopy = {
    name: PRODUCT_NAME[reason] ?? label,
    providerLabel: label,
    purpose: PURPOSE[reason],
  }
  // One Atlassian grant reaches both products, so a user connecting for Jira
  // should know Confluence came with it rather than being asked twice.
  if (provider === 'atlassian') {
    copy.note = 'One Atlassian connection covers both Confluence and Jira.'
  }
  return copy
}

/** An integration is named by the host's admin, so its copy has no table: it is the name. */
export function integrationConnectCardCopy(integrationName: string): ConnectCardCopy {
  return {
    name: integrationName,
    providerLabel: integrationName,
    purpose: 'Needed to use its tools.',
  }
}

export function connectRequestCopy(request: ConnectRequest): ConnectCardCopy {
  if (request.kind === 'custom-server') {
    const name = request.name ?? 'MCP server'
    return { name, providerLabel: name, purpose: 'Enter its address to add it.' }
  }
  return request.kind === 'integration' ? integrationConnectCardCopy(request.integrationName) : connectCardCopy(request.provider, request.reason)
}

/** The card's eyebrow: how many sign-ins it asks for, or that it asks for none now. */
export function connectCardHeading(total: number, settled: number, needsOnlyAddress = false): string {
  if (needsOnlyAddress) return 'Server address needed'
  if (settled === total) return total === 1 ? 'Connected' : 'All connected'
  return total === 1 ? 'Sign-in needed' : `${total} sign-ins needed`
}

/** The prompt that restarts the turn, naming every account that is now connected. */
export function connectContinuePrompt(labels: string[]): string {
  return `${new Intl.ListFormat('en', { type: 'conjunction' }).format(labels)} connected — continue`
}
