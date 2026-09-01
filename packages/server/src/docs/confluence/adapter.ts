import { z } from 'zod'
import type {
  DocDestination,
  DocDraft,
  DocPatch,
  DocProviderId,
  DocProviderStatus,
  DocRef,
  DocScope,
  DocSummary,
  NormalizedDoc,
} from '@solus/contracts/docs'
import { currentCredential } from '../../atlassian/oauth'
import {
  atlassianRequest,
  type AtlassianFailure,
  type AtlassianRequest,
} from '../../atlassian/api'
import { loadCredential, type AtlassianStoredCredential } from '../../atlassian/token-store'
import { DocProviderUnavailableError, DocVersionConflictError, type DocProviderAdapter } from '../types'
import { markdownToStorage, storageToMarkdown } from './storage-format'

/**
 * Confluence Cloud, reached through the site connection made in phase 1.
 *
 * An OAuth grant addresses the site as `api.atlassian.com/ex/confluence/<cloudId>`
 * rather than by hostname, which is why `cloudId` is the persisted site identity
 * — a renamed site keeps working and every external key stays valid.
 *
 * A `DocScope` here is `<spaceKey>`, optionally `<spaceKey>/<parentPageId>` to
 * create beneath a page. The `externalKey` persisted in a link is the durable
 * `<cloudId>/<spaceKey>`.
 */

const spaceSchema = z.object({ id: z.string(), key: z.string(), name: z.string() })
const spacesSchema = z.object({ results: z.array(spaceSchema) })

const pageSchema = z.object({
  id: z.string(),
  title: z.string(),
  spaceId: z.string().optional(),
  version: z.object({ number: z.number(), createdAt: z.string().optional() }).optional(),
  body: z.object({ storage: z.object({ value: z.string() }).optional() }).optional(),
  _links: z.object({ webui: z.string().optional() }).optional(),
})

const searchResultSchema = z.object({
  results: z.array(
    z.object({
      content: z.object({ id: z.string(), title: z.string(), type: z.string() }).optional(),
      title: z.string().optional(),
      excerpt: z.string().optional(),
      lastModified: z.string().optional(),
      url: z.string().optional(),
    }),
  ),
})

/** The v2 create-page request. `spaceId` is numeric and internal, which is why
 *  a scope names the space by key and the id is resolved here. */
interface CreatePageBody {
  spaceId: string
  status: 'current'
  title: string
  body: { representation: 'storage'; value: string }
  parentId?: string
}

/** The v2 update-page request. Confluence's required
 *  `version.number = current + 1` is optimistic concurrency built into the API. */
interface UpdatePageBody {
  id: string
  status: 'current'
  title: string
  body: { representation: 'storage'; value: string }
  version: { number: number; message: string }
}

interface ConfluenceRequestInit {
  method?: 'POST' | 'PUT'
  /** The object, not a JSON string: the shared transport serializes it. */
  body?: CreatePageBody | UpdatePageBody
}

interface ScopeParts {
  spaceKey: string
  parentId?: string
}

function scopeParts(scope: DocScope): ScopeParts {
  const [spaceKey = '', parentId] = scope.split('/')
  return parentId ? { spaceKey, parentId } : { spaceKey }
}

/** The site a link was written against, read back out of its `externalKey`.
 *  The transport refuses a call whose site is not the connected one, which is
 *  what stops a page id from being resolved against the wrong site. */
function linkedCloudId(ref: DocRef): string {
  const cloudId = ref.externalKey.split('/')[0]
  if (!cloudId) throw new Error(`Invalid Confluence doc scope: ${ref.externalKey}`)
  return cloudId
}

/** CQL string literals are double-quoted, so a quote in the query would end the
 *  clause early and make the whole search fail. */
function cqlLiteral(value: string): string {
  return `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`
}

export class ConfluenceDocAdapter implements DocProviderAdapter {
  readonly id = 'confluence' as const

  async status(): Promise<DocProviderStatus> {
    const credential = loadCredential()
    if (!credential) {
      return {
        provider: this.id,
        connected: false,
        reason: 'No Atlassian site is connected.',
        connectable: true,
      }
    }
    if (!credential.products.includes('confluence')) {
      // Signing in again reaches the same site and the same licence, so this is
      // not something a Connect button can fix.
      return {
        provider: this.id,
        connected: false,
        reason: `The connected Atlassian site (${credential.siteUrl}) does not grant Confluence access.`,
        connectable: false,
      }
    }
    return { provider: this.id, connected: true }
  }

  async destinations(): Promise<DocDestination[]> {
    const credential = await this.credential()
    const spaces = await this.request(credential.cloudId, '/wiki/api/v2/spaces?limit=250', spacesSchema)
    return spaces.results.map((space) => ({
      provider: this.id,
      scope: space.key,
      label: space.name,
    }))
  }

  async search(scope: DocScope | undefined, query: string): Promise<DocSummary[]> {
    const credential = await this.credential()
    const clauses = [`type = page`, `text ~ ${cqlLiteral(query)}`]
    if (scope) clauses.push(`space = ${cqlLiteral(scopeParts(scope).spaceKey)}`)
    const cql = encodeURIComponent(clauses.join(' and '))
    const found = await this.request(credential.cloudId, `/wiki/rest/api/search?cql=${cql}&limit=20`, searchResultSchema)

    return found.results.flatMap((result) => {
      if (!result.content) return []
      const summary: DocSummary = {
        ref: this.ref(credential, scope ? scopeParts(scope).spaceKey : '', result.content.id, result.url ?? ''),
        title: result.content.title || result.title || 'Untitled',
        kind: 'page',
      }
      if (result.lastModified) summary.updatedAt = result.lastModified
      // Confluence returns its excerpt with @@@hl@@@ highlight markers.
      if (result.excerpt) summary.excerpt = result.excerpt.replaceAll(/@@@(end)?hl@@@/g, '')
      return [summary]
    })
  }

  async read(ref: DocRef): Promise<NormalizedDoc> {
    const page = await this.request(
      linkedCloudId(ref),
      `/wiki/api/v2/pages/${encodeURIComponent(ref.externalId)}?body-format=storage`,
      pageSchema,
    )
    return this.normalize(await this.credential(), page, ref.externalKey.split('/')[1] ?? '')
  }

  async create(scope: DocScope, doc: DocDraft): Promise<NormalizedDoc> {
    const credential = await this.credential()
    const { spaceKey, parentId } = scopeParts(scope)
    const spaceId = await this.spaceId(credential.cloudId, spaceKey)
    const body: CreatePageBody = {
      spaceId,
      status: 'current',
      title: doc.title,
      body: { representation: 'storage', value: markdownToStorage(doc.markdown) },
    }
    if (parentId) body.parentId = parentId

    const page = await this.request(credential.cloudId, '/wiki/api/v2/pages', pageSchema, {
      method: 'POST',
      body,
    })
    return this.normalize(credential, page, spaceKey)
  }

  async update(ref: DocRef, patch: DocPatch): Promise<NormalizedDoc> {
    const credential = await this.credential()
    const spaceKey = ref.externalKey.split('/')[1] ?? ''
    const cloudId = linkedCloudId(ref)
    const current = await this.request(cloudId, `/wiki/api/v2/pages/${encodeURIComponent(ref.externalId)}`, pageSchema)
    const currentVersion = current.version?.number ?? 0

    // Confluence's required `version.number = current + 1` is optimistic
    // concurrency built into the API; checking first turns the rejection into a
    // conflict the user can act on rather than a raw HTTP 409.
    if (patch.expectedVersion !== undefined && patch.expectedVersion !== String(currentVersion)) {
      throw new DocVersionConflictError(String(currentVersion), current.version?.createdAt)
    }

    const page = await this.request(cloudId, `/wiki/api/v2/pages/${encodeURIComponent(ref.externalId)}`, pageSchema, {
      method: 'PUT',
      body: {
        id: ref.externalId,
        status: 'current',
        title: patch.title ?? current.title,
        body: { representation: 'storage', value: markdownToStorage(patch.markdown) },
        version: { number: currentVersion + 1, message: 'Updated from Solus' },
      },
    })
    return this.normalize(credential, page, spaceKey)
  }

  resolveUrl(url: string): DocRef | null {
    const credential = loadCredential()
    if (!credential) return null
    let parsed: URL
    try {
      parsed = new URL(url)
    } catch {
      return null
    }
    if (parsed.origin !== new URL(credential.siteUrl).origin) return null

    const spacePage = parsed.pathname.match(/\/wiki\/spaces\/([^/]+)\/pages\/(\d+)/)
    if (spacePage) return this.ref(credential, decodeURIComponent(spacePage[1]!), spacePage[2]!, url)

    const legacy = parsed.searchParams.get('pageId')
    if (legacy && parsed.pathname.includes('/wiki/')) return this.ref(credential, '', legacy, url)

    return null
  }

  private ref(credential: AtlassianStoredCredential, spaceKey: string, pageId: string, url: string): DocRef {
    return {
      provider: this.id,
      externalKey: `${credential.cloudId}/${spaceKey}`,
      externalId: pageId,
      url: url.startsWith('http') ? url : `${credential.siteUrl}/wiki${url}`,
    }
  }

  private normalize(
    credential: AtlassianStoredCredential,
    page: z.infer<typeof pageSchema>,
    spaceKey: string,
  ): NormalizedDoc {
    const { markdown, lossyParts } = storageToMarkdown(page.body?.storage?.value ?? '')
    const doc: NormalizedDoc = {
      ref: this.ref(credential, spaceKey, page.id, page._links?.webui ?? `/pages/${page.id}`),
      title: page.title,
      markdown,
    }
    if (page.version?.number !== undefined) doc.version = String(page.version.number)
    if (page.version?.createdAt) doc.updatedAt = page.version.createdAt
    if (lossyParts.length) doc.lossyParts = lossyParts
    return doc
  }

  private async spaceId(cloudId: string, spaceKey: string): Promise<string> {
    const spaces = await this.request(cloudId, `/wiki/api/v2/spaces?keys=${encodeURIComponent(spaceKey)}&limit=1`, spacesSchema)
    const space = spaces.results[0]
    if (!space) throw new Error(`No Confluence space with key "${spaceKey}" is reachable with this connection.`)
    return space.id
  }

  /** Always through `currentCredential`, which refreshes an expired token first
   *  — an adapter must never think about expiry. */
  private async credential(): Promise<AtlassianStoredCredential> {
    const credential = await currentCredential()
    if (!credential) {
      throw new DocProviderUnavailableError(this.id, 'No Atlassian site is connected, or the connection expired. Reconnect in Settings → Providers.')
    }
    if (!credential.products.includes('confluence')) {
      throw new DocProviderUnavailableError(this.id, `The connected Atlassian site (${credential.siteUrl}) does not grant Confluence access.`)
    }
    return credential
  }

  /**
   * Every Confluence call goes through the shared Atlassian transport, the same
   * one the Jira task adapter uses — one site, one grant, one door. What differs
   * is only what a refusal *means* here, which `docFailure` supplies.
   *
   * `cloudId` is passed rather than assumed, so a page addressed by a link
   * written against another site is refused instead of being looked up on
   * whichever site happens to be connected now. Page ids are per-site.
   */
  private request<T extends z.ZodType>(
    cloudId: string,
    path: string,
    schema: T,
    init: ConfluenceRequestInit = {},
  ): Promise<z.infer<T>> {
    const request: AtlassianRequest = {
      product: 'confluence',
      cloudId,
      path,
      failure: (failure) => docFailure(this.id, failure),
    }
    if (init.method === 'POST' || init.method === 'PUT') request.method = init.method
    if (init.body !== undefined) request.body = init.body
    return atlassianRequest(request, schema)
  }
}

/** What a refused Atlassian call means to the document layer. A conflict is the
 *  one refusal the user can act on directly, so it keeps its own type rather
 *  than reading as a generic failure. */
function docFailure(provider: DocProviderId, failure: AtlassianFailure): Error {
  if (failure.status === 409) return new DocVersionConflictError()
  // Confluence says this when the token carries a scope the endpoint does not
  // accept. It is not a dead connection, so "reconnect" alone would read as
  // superstition: the grant predates a permission Solus now asks for, and only
  // a fresh sign-in can add it.
  if (/scope does not match/i.test(failure.detail)) {
    return new DocProviderUnavailableError(
      provider,
      'This Atlassian connection was granted before Solus asked for Confluence page permissions. Disconnect and sign in again in Settings → Providers.',
    )
  }
  if (failure.status === 401 || failure.status === 403) {
    return new DocProviderUnavailableError(provider, `${failure.detail} Reconnect the Atlassian site in Settings → Providers.`)
  }
  return new Error(`Confluence request failed (HTTP ${failure.status}): ${failure.detail}`)
}
