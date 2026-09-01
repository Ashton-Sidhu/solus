import { CONNECTION_LABELS } from '@solus/contracts/connections'
import type { ConnectionProvider, ConnectionReason } from '@solus/contracts/connections'

/**
 * What the card says. Kept out of the component because it is a table, not
 * markup, and because the reason — not the provider — is what the user
 * recognizes: someone who asked to "set up Jira" should not be answered with
 * the word "Atlassian" alone.
 */

export interface ConnectCardCopy {
  /** The product the user named, which may not be the account's name. */
  title: string
  eyebrow: string
  /** One line on why this is being asked for now. */
  purpose: string
  /** Present when one account serves more than the product the user named. */
  note?: string
}

const PURPOSE: Record<ConnectionReason, string> = {
  deploy: 'Needed to put this online. Free — no credit card.',
  'pull-requests': 'Needed to read and write pull requests on your behalf.',
  issues: 'Needed to read and write issues on your behalf.',
  confluence: 'Needed to read and publish Confluence pages.',
  jira: 'Needed to read and update Jira issues.',
  drive: 'Needed to read and write your Google Docs.',
  unspecified: 'Needed to continue.',
}

/** Reasons whose product name differs from the account being connected. */
const PRODUCT_TITLE: Partial<Record<ConnectionReason, string>> = {
  confluence: 'Connect Confluence',
  jira: 'Connect Jira',
}

export function connectCardCopy(
  provider: ConnectionProvider,
  reason: ConnectionReason,
): ConnectCardCopy {
  const label = CONNECTION_LABELS[provider]
  const copy: ConnectCardCopy = {
    title: PRODUCT_TITLE[reason] ?? `Connect ${label}`,
    eyebrow: label,
    purpose: PURPOSE[reason],
  }
  // One Atlassian grant reaches both products, so a user connecting for Jira
  // should know Confluence came with it rather than being asked twice.
  if (provider === 'atlassian') {
    copy.note = 'One Atlassian sign-in covers both Confluence and Jira.'
  }
  return copy
}
