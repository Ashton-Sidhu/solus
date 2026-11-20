import { clientMetadataDocumentSchema, namesItsUrl, SOLUS_CLIENT_ID_URL, type ClientMetadataDocument } from '@solus/contracts/integrations/client-metadata-document'
import { createLogger } from '../logger'

const log = createLogger('integrations', 'client-metadata.ts')

/**
 * Whether Solus's Client ID Metadata Document is published (docs/plans/mcp-integrations.md
 * §13.1). The site is deployed apart from the host, and a host can be offline
 * or self-hosted. An authorization server fetches the `client_id` URL itself,
 * so a URL that does not answer with the same document fails the sign-in in
 * the person's browser, where Solus cannot fall back. The host therefore reads
 * the document on demand, as the catalog reads its published file, and signs
 * in with it only when the copy it read is valid and names its own URL.
 *
 * A confirmed copy is read again after an hour, and used for up to a day
 * while reads fail. After a failed read the host waits five minutes before it
 * reads again, so an offline host does not wait on the read at every sign-in.
 */

const FETCH_TIMEOUT_MS = 5_000
const FRESH_MS = 60 * 60 * 1000
const STALE_LIMIT_MS = 24 * 60 * 60 * 1000
const RETRY_MS = 5 * 60 * 1000

export class PublishedClientMetadata {
  private confirmed: { document: ClientMetadataDocument; readAt: number } | null = null
  private failedAt: number | null = null
  private pending: Promise<ClientMetadataDocument | null> | null = null

  constructor(private readonly deps: { fetch?: typeof fetch; now?: () => number } = {}) {}

  /** The document's URL: a self-hosted deployment names its own with `SOLUS_OAUTH_CLIENT_METADATA_URL`. */
  get url(): string {
    return process.env.SOLUS_OAUTH_CLIENT_METADATA_URL || SOLUS_CLIENT_ID_URL
  }

  /** The published document, when it is confirmed; null when the host cannot rely on it. Never throws. */
  async current(): Promise<ClientMetadataDocument | null> {
    const now = this.now()
    const copy = this.copyFor(this.url)
    if (copy && now - copy.readAt < FRESH_MS) return copy.document
    if (this.failedAt !== null && now - this.failedAt < RETRY_MS) return this.usable(now)
    this.pending ??= this.read().finally(() => { this.pending = null })
    return this.pending
  }

  private async read(): Promise<ClientMetadataDocument | null> {
    const url = this.url
    try {
      const response = await (this.deps.fetch ?? fetch)(url, {
        redirect: 'manual',
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        headers: { accept: 'application/json' },
      })
      // An authorization server takes only a 200 and follows no redirect (draft §4, §6).
      if (response.status !== 200) {
        await response.body?.cancel().catch(() => undefined)
        throw new Error(`status ${response.status}`)
      }
      const parsed = clientMetadataDocumentSchema.safeParse(await response.json().catch(() => undefined))
      if (!parsed.success || !namesItsUrl(parsed.data, url)) throw new Error('not a valid document for its URL')
      this.confirmed = { document: parsed.data, readAt: this.now() }
      this.failedAt = null
      return parsed.data
    } catch (error) {
      this.failedAt = this.now()
      const kept = this.usable(this.failedAt)
      log.warn('client_metadata_unconfirmed', { error: error instanceof Error ? error.message : String(error), keptCopy: kept !== null })
      return kept
    }
  }

  /** The last confirmed copy, while it is under a day old. */
  private usable(now: number): ClientMetadataDocument | null {
    const copy = this.copyFor(this.url)
    return copy && now - copy.readAt < STALE_LIMIT_MS ? copy.document : null
  }

  /** A copy read from another URL (the setting changed) confirms nothing. */
  private copyFor(url: string): { document: ClientMetadataDocument; readAt: number } | null {
    return this.confirmed?.document.client_id === url ? this.confirmed : null
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now()
  }
}
