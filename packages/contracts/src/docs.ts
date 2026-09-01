// The document provider surface: one shared shape for a Confluence page and a
// Google Doc. Provider-native formats, scopes, states, and URLs are normalized
// at the adapter boundary; nothing provider-shaped travels past it.
//
// `doc` is the single word for a provider document. `page` and `file` appear
// only inside an adapter, where they are the provider's own word.

export type DocProviderId = 'gdrive' | 'confluence'

/**
 * Where a doc is addressed from and written to, as the provider reads it.
 *
 * Confluence: `<spaceKey>` or `<spaceKey>/<parentPageId>`.
 * Google Drive: a folder id, or `root`.
 *
 * The string is opaque to every consumer — only the adapter interprets it.
 */
export type DocScope = string

/** How a doc is addressed. `externalKey` is the durable scope the doc lives in
 * (`<cloudId>/<spaceKey>` for Confluence, the folder id for Drive), so a moved
 * or renamed doc still resolves. */
export interface DocRef {
  provider: DocProviderId
  externalKey: string
  externalId: string
  url: string
}

/** One search hit. Enough to show a row and read the doc; never the body. */
export interface DocSummary {
  ref: DocRef
  title: string
  updatedAt?: string
  /** The provider's own word for this thing, shown as-is: `page`, `document`. */
  kind?: string
  excerpt?: string
}

/**
 * A doc read into Solus's own vocabulary. `markdown` is the content; `version`
 * is the provider's concurrency token — a Confluence version number or a Drive
 * version counter — and is the value a later write must still match.
 */
export interface NormalizedDoc {
  ref: DocRef
  title: string
  markdown: string
  updatedAt?: string
  version?: string
  /** Named parts the markdown could not carry (macros, suggestions, embeds).
   *  Shown to the user rather than dropped silently. */
  lossyParts?: string[]
}

/** A rendered Solus diagram carried with a publish request. Rendering stays on
 * the client because web and remote clients cannot assume the host has a
 * browser canvas. The server validates the bounded PNG before provider use. */
export interface DocDiagramAsset {
  workId: string
  title: string
  mimeType: 'image/png'
  base64: string
}

export interface DocDraft {
  title: string
  markdown: string
  diagramAssets?: DocDiagramAsset[]
}

export interface DocPatch {
  title?: string
  markdown: string
  diagramAssets?: DocDiagramAsset[]
  /** The version the caller last saw. A mismatch is a conflict, not an
   *  overwrite; omit only to force a write the user has explicitly chosen. */
  expectedVersion?: string
}

/** A place a doc can be created — a Confluence space or a Drive folder. Filled
 *  by the destination picker on first publish and then remembered in the link. */
export interface DocDestination {
  provider: DocProviderId
  scope: DocScope
  /** Human label for the chosen place, e.g. "Engineering" or "My Drive". */
  label: string
}

/** How a linked work stands against its upstream doc. `dirty` means the local
 *  content moved since the last publish; `conflict` means upstream did. */
export type DocSyncState = 'ok' | 'dirty' | 'upstream_changed' | 'conflict' | 'error' | 'auth_error'

/**
 * The upstream doc a work mirrors — the doc-shaped twin of `TaskExternalLink`.
 * Stored with the work's metadata in both storage backends, so a project work
 * carries its link in the manifest and a local work in its meta row.
 */
export interface WorkExternalLink extends DocRef {
  /** The place the doc was created in, kept so every later publish is one
  *  keystroke and the picker is never shown twice for one work. */
  scope: DocScope
  upstreamVersion?: string
  /** Hash of the content Solus last pushed. Content ≠ hash means `dirty`. */
  lastPushedContentHash?: string
  syncState: DocSyncState
  syncError?: string
}

/** What a publish call carries. `destination` answers the first publish only;
 *  afterwards the link remembers where the doc lives. */
export interface WorkPublishRequest {
  cwd?: string
  destination?: DocDestination
  /** Renderer-prepared diagram PNGs. Google Docs embeds them; providers that
   * cannot carry them receive explicit captions instead. */
  diagramAssets?: DocDiagramAsset[]
  /** Publish over an upstream change the user has chosen to discard. */
  force?: boolean
}

/** A plan body is not a Folio work, so its publish request carries the plan
 * identity and current content. Its link is persisted in PlanAnnotations. */
export interface PlanPublishRequest extends Omit<WorkPublishRequest, 'cwd'> {
  sessionId: string
  planToolUseId: string
  title: string
  content: string
}

export interface DocProviderStatus {
  provider: DocProviderId
  connected: boolean
  /** Why it is unusable, in words the UI can show as-is. */
  reason?: string
  /** Whether signing in on this host could make it usable. A provider missing
   *  its OAuth client, or a site whose licence excludes the product, is not
   *  connectable — offering "Connect" there sends the user somewhere that
   *  cannot help. Only meaningful while `connected` is false. */
  connectable?: boolean
  /** What a connected provider still cannot do, in words the UI and the agent
   *  can show as-is — a Drive grant without `drive.readonly` publishes but
   *  cannot see a doc Solus did not create. An empty search must never be the
   *  only evidence of that. */
  limitation?: string
}

/** Publish outcome. A conflict is an answer, not a failure: the caller decides
 *  between pulling first and overwriting. */
export type WorkPublishResult =
  /** `lossyParts` names what the published page could not carry — an embedded
   *  diagram, today — so the loss is stated rather than discovered later. */
  | { ok: true; link: WorkExternalLink; lossyParts?: string[] }
  | { ok: false; conflict: true; link: WorkExternalLink; upstreamUpdatedAt?: string }
  | { ok: false; conflict?: false; error: string; link?: WorkExternalLink }

export type WorkPullResult =
  | { ok: true; link: WorkExternalLink; title: string; content: string; lossyParts?: string[] }
  | { ok: false; error: string }
