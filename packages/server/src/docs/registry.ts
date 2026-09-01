import type { DocProviderId, DocProviderStatus, DocRef } from '@solus/contracts/docs'
import { ConfluenceDocAdapter } from './confluence/adapter'
import { GoogleDriveDocAdapter } from './gdrive/adapter'
import type { DocProviderAdapter } from './types'

/**
 * Adding a document provider is one adapter file and one entry here — no new
 * tool, contract, or settings pattern. Everything downstream routes by id.
 */
const adapters = new Map<DocProviderId, DocProviderAdapter>([
  ['confluence', new ConfluenceDocAdapter()],
  ['gdrive', new GoogleDriveDocAdapter()],
])

export function docProviderIds(): DocProviderId[] {
  return [...adapters.keys()]
}

/**
 * The provider name arrives as a plain string from an agent and is validated
 * here, at execution time: tool schemas are built once at session start, and a
 * provider can be connected or disconnected mid-session.
 */
export function docProviderAdapter(provider: string): DocProviderAdapter {
  // SAFETY: the lookup itself is the validation — a string that is not a
  // DocProviderId simply misses the map and takes the throw below.
  const adapter = adapters.get(provider as DocProviderId)
  if (!adapter) {
    throw new Error(`"${provider}" is not a document provider. Supported: ${docProviderIds().join(', ')}.`)
  }
  return adapter
}

export async function docProviderStatuses(): Promise<DocProviderStatus[]> {
  return Promise.all([...adapters.values()].map((adapter) => adapter.status()))
}

/** The first adapter that claims the URL. Users hand agents links, not ids, so
 *  this — not a provider argument — is the usual way a doc is addressed. */
export function resolveDocUrl(url: string): { adapter: DocProviderAdapter; ref: DocRef } | null {
  for (const adapter of adapters.values()) {
    const ref = adapter.resolveUrl(url)
    if (ref) return { adapter, ref }
  }
  return null
}
