import type { DocProviderId } from '@solus/contracts/docs'
import { docProviderLabel } from './work-publish'

/**
 * What the import dialog says. A user who chose a provider from the menu has
 * already answered "from where", so the dialog names that provider and shows
 * the shape of link it wants; reached without a choice, it stays open to both.
 */
export interface ImportDocCopy {
  title: string
  description: string
  placeholder: string
}

const PLACEHOLDERS = {
  confluence: 'https://acme.atlassian.net/wiki/spaces/…',
  gdrive: 'https://docs.google.com/document/d/…',
} satisfies Record<DocProviderId, string>

export function importDocCopy(provider?: DocProviderId): ImportDocCopy {
  const linked = 'Solus imports it as a document and keeps it linked, so you can publish changes back.'
  if (!provider) {
    return {
      title: 'Import a document',
      description: `Paste a Confluence or Google Drive link. ${linked}`,
      placeholder: PLACEHOLDERS.confluence,
    }
  }
  const label = docProviderLabel(provider)
  return {
    title: `Import from ${label}`,
    description: `Paste a ${label} link. ${linked}`,
    placeholder: PLACEHOLDERS[provider],
  }
}
