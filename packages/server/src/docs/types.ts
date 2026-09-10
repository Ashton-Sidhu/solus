import type { DocCommentAction, DocCommentMutationResult, DocCommentMutation, DocCommentThread } from '@solus/contracts/doc-comments'
import type {
  DocDestination,
  DocDraft,
  DocPatch,
  DocProviderId,
  DocProviderStatus,
  DocReadHints,
  DocRef,
  DocScope,
  DocSummary,
  NormalizedDoc,
} from '@solus/contracts/docs'

/**
 * The provider boundary for documents. Everything provider-native — storage
 * XHTML, ADF, export MIME types, space ids, folder ids, web URLs — is converted
 * here. A consumer only ever sees markdown and a `DocRef`.
 */
export interface DocProviderAdapter {
  readonly id: DocProviderId
  /** Omitted when this adapter has no comment integration. */
  readonly comments?: DocCommentsAdapter
  /** Whether this provider can be used right now, and if not, why — the answer
   *  the agent and the UI both show, so a missing connection reads the same
   *  either way. */
  status(): Promise<DocProviderStatus>
  /** Places a doc can be created: Confluence spaces, Drive folders. Feeds the
   *  first-publish destination picker. */
  destinations(): Promise<DocDestination[]>
  search(scope: DocScope | undefined, query: string): Promise<DocSummary[]>
  read(ref: DocRef, hints?: DocReadHints): Promise<NormalizedDoc>
  create(scope: DocScope, doc: DocDraft): Promise<NormalizedDoc>
  update(ref: DocRef, patch: DocPatch): Promise<NormalizedDoc>
  /** Parse a provider-native URL into a ref, or null when the URL is not ours.
   *  Users hand agents links, not ids. */
  resolveUrl(url: string): DocRef | null
}

/** An upstream write that lost a race. Thrown by `update` so publish can offer
 *  pull-first or overwrite instead of reporting a generic failure. */
export class DocVersionConflictError extends Error {
  constructor(readonly upstreamVersion?: string, readonly upstreamUpdatedAt?: string) {
    super('The upstream doc changed since Solus last saw it.')
    this.name = 'DocVersionConflictError'
  }
}

/** The provider is not connected, or its grant no longer works. Separated from
 *  an ordinary failure because the fix is always "connect", never "retry". */
export class DocProviderUnavailableError extends Error {
  constructor(readonly provider: DocProviderId, message: string) {
    super(message)
    this.name = 'DocProviderUnavailableError'
  }
}

/** A definite rejection may be retried; an uncertain write must not be reposted. */
export class DocCommentRequestError extends Error {
  constructor(message: string, readonly uncertain: boolean) {
    super(message)
    this.name = 'DocCommentRequestError'
  }
}

/** Optional provider capability. Actions describe support, not document permissions.
 * The host owns private/shared state and delivery receipts. The provider owns
 * authentication, permission checks, and API conversion. Never retry uncertain writes.
 */
export interface DocCommentsAdapter {
  readonly actions: readonly DocCommentAction[]
  readonly limitations: string[]
  /** A complete snapshot; reject if any page fails. */
  list(ref: DocRef): Promise<DocCommentThread[]>
  mutate(ref: DocRef, mutation: DocCommentMutation): Promise<DocCommentMutationResult>
}
