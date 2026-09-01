import type { DocProviderId, WorkExternalLink } from '@solus/contracts/docs'
import { PROVIDER_LOGOS } from '../../settings/lib/provider-logos'

/**
 * One name per provider, used wherever a linked doc is described. The provider
 * is Google Drive — the place a document is published to and picked from. A
 * Google Doc is the artifact that lands there; the two are not the same word.
 */
export const DOC_PROVIDER_LABELS = {
  confluence: 'Confluence',
  gdrive: 'Google Drive',
} satisfies Record<DocProviderId, string>

export function docProviderLabel(provider: DocProviderId): string {
  return DOC_PROVIDER_LABELS[provider] ?? provider
}

/** Full-colour provider marks shared by the work header and Workspace ledger. */
export const DOC_PROVIDER_LOGOS = {
  confluence: PROVIDER_LOGOS.confluence,
  gdrive: PROVIDER_LOGOS.google,
} satisfies Record<DocProviderId, string>

export function docProviderLogo(provider: DocProviderId): string {
  return DOC_PROVIDER_LOGOS[provider]
}

/** Where a first publish puts the doc, in the provider's own words. */
export function destinationNoun(provider: DocProviderId): string {
  return provider === 'confluence' ? 'space' : 'folder'
}

export interface DocSyncChip {
  label: string
  /** Drives the chip's colour: neutral for settled states, attention for the
   *  ones that need a decision. */
  tone: 'neutral' | 'pending' | 'warning' | 'error'
  title: string
}

/**
 * What the header says about the link. Every state names the next action, so
 * the chip is never a status the user cannot act on.
 */
export function docSyncChip(link: WorkExternalLink | undefined): DocSyncChip {
  if (!link) return { label: 'Publish', tone: 'neutral', title: 'Publish this document to Confluence or Google Drive' }
  const where = docProviderLabel(link.provider)
  switch (link.syncState) {
    case 'ok':
      return { label: 'Published', tone: 'neutral', title: `Up to date with ${where}` }
    case 'dirty':
      return { label: 'Update', tone: 'pending', title: `This document has changed since it was published to ${where}` }
    case 'upstream_changed':
      return { label: 'Upstream changed', tone: 'warning', title: `The ${where} page changed since Solus last saw it. Pull it down before publishing.` }
    case 'conflict':
      return { label: 'Conflict', tone: 'warning', title: `The ${where} page changed since Solus last published. Pull it down, or publish over it.` }
    case 'auth_error':
      return { label: 'Reconnect', tone: 'error', title: link.syncError ?? `Solus can no longer reach ${where}.` }
    case 'error':
      return { label: 'Sync error', tone: 'error', title: link.syncError ?? `The last ${where} sync failed.` }
  }
}
