import { withConfluencePage } from './page-lock'
import { z } from 'zod'
import { confluenceMarkerQuotes, requireUniqueConfluenceQuote } from './inline-markers'
import type { DocCommentAction, DocCommentMutationResult, DocCommentMutation, DocCommentThread } from '@solus/contracts/doc-comments'
import type { DocRef } from '@solus/contracts/docs'
import { atlassianRequest, IGNORED_RESPONSE } from '../../atlassian/api'
import { currentCredential } from '../../atlassian/oauth'
import { DocCommentRequestError, type DocCommentsAdapter } from '../types'
import { markdownToStorage, storageToMarkdown } from './storage-format'

const versionSchema = z.object({ number: z.number().int().positive(), createdAt: z.string(), authorId: z.string().optional() })
const commentSchema = z.object({
  id: z.string(), pageId: z.string().optional(), parentCommentId: z.string().optional(),
  status: z.string(), version: versionSchema,
  body: z.object({ storage: z.object({ value: z.string() }).optional() }).optional(),
  resolutionStatus: z.enum(['open', 'resolved', 'reopened', 'dangling']).optional(),
  properties: z.object({ inlineMarkerRef: z.string().optional(), inlineOriginalSelection: z.string().optional() }).optional(),
})
const pageSchema = z.object({ results: z.array(commentSchema), _links: z.object({ next: z.string().optional() }).optional() })
const userSchema = z.object({ accountId: z.string(), displayName: z.string().optional(), publicName: z.string().optional() })
type Comment = z.infer<typeof commentSchema>
type OriginalVersion = z.infer<typeof versionSchema>
type Kind = 'footer' | 'inline'
interface Thread { kind: Kind; comment: Comment; replies: Comment[] }
interface CommentBody { representation: 'storage'; value: string }
type WriteBody =
  | { pageId: string; body: CommentBody; inlineCommentProperties?: { textSelection: string; textSelectionMatchCount: number; textSelectionMatchIndex: number } }
  | { parentCommentId: string; body: CommentBody }
  | { version: { number: number }; body?: CommentBody; resolved?: boolean }
  | { accountIds: string[] }

const createdCommentSchema = z.object({ id: z.string().optional() }).optional()

function threadActions(kind: Kind, comment: Comment, attachmentState?: 'attached' | 'detached' | 'unknown'): DocCommentAction[] {
  if (isDeleted(comment)) return []
  if (kind === 'inline' && attachmentState !== 'attached') return ['reply', 'delete']
  return ['reply', 'edit', 'delete', ...(kind === 'inline' ? [comment.resolutionStatus === 'resolved' ? 'reopen' as const : 'resolve' as const] : [])]
}

function inlineAnchor(comment: Comment, quotes: Map<string, string | undefined>) {
  const markerRef = comment.properties?.inlineMarkerRef ?? ''
  const quote = quotes.get(markerRef)
  const attachmentState = comment.resolutionStatus === 'dangling' || !quotes.has(markerRef) ? 'detached' as const
    : quote ? 'attached' as const : 'unknown' as const
  return { quote: attachmentState === 'unknown' ? '' : quote ?? comment.properties?.inlineOriginalSelection ?? '', attachmentState }
}

/** Bound independent reads and drain them before returning an error. */
async function mapCommentReads<T, R>(items: readonly T[], read: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = []
  let cursor = 0
  let failed = false
  const workers = await Promise.allSettled(Array.from({ length: Math.min(4, items.length) }, async () => {
    while (!failed && cursor < items.length) {
      const index = cursor++
      try { results[index] = await read(items[index]!) }
      catch (error) { failed = true; throw error }
    }
  }))
  for (const worker of workers) if (worker.status === 'rejected') throw worker.reason
  return results
}

function key(kind: Kind, commentId: string): string { return `${kind}:${commentId}` }
function isDeleted(comment: Comment): boolean { return comment.status === 'deleted' || comment.status === 'trashed' }

/** Confluence page and inline discussions share one capability, but retain their kind. */
export class ConfluenceDocComments implements DocCommentsAdapter {
  private readonly originalVersions = new Map<string, OriginalVersion>()
  readonly actions = ['create', 'reply', 'edit', 'delete', 'resolve', 'reopen'] as const
  readonly limitations = [
    'Quoted comments attach to a unique passage in the published page. Publish text edits first; missing or repeated selections are refused. Unquoted comments are page discussions.',
    'Resolve/reopen applies only to attached inline threads. Detached or unreadable anchors allow replies and deletion only.',
    'Confluence enforces comment permissions. Reconnect Atlassian if comment scopes are missing.',
    'Edits use Confluence version checks. Deletes check the last read time but have no atomic version precondition.',
    'Nested replies are returned as a flat list within their root thread. Deleted comments are included only when Confluence returns them.',
  ]

  private async site(ref: DocRef, scope: string): Promise<string> {
    const cloudId = ref.externalKey.split('/')[0]
    if (ref.provider !== 'confluence' || !cloudId) throw new DocCommentRequestError('This is not a Confluence page reference.', false)
    const credential = await currentCredential()
    if (!credential || credential.cloudId !== cloudId || !credential.products.includes('confluence')) {
      throw new DocCommentRequestError('Connect the Atlassian site that owns this page.', false)
    }
    if (!credential.scopes.includes(scope)) throw new DocCommentRequestError(`Reconnect Atlassian to grant ${scope}.`, false)
    return cloudId
  }

  private async request<S extends z.ZodType>(cloudId: string, path: string, schema: S, method: 'GET' | 'POST' | 'PUT' | 'DELETE' = 'GET', body?: WriteBody): Promise<z.infer<S>> {
    const isWrite = method !== 'GET' && path !== '/wiki/api/v2/users-bulk'
    try {
      return await atlassianRequest({
        product: 'confluence', cloudId, path, method, body,
        failure: ({ status, detail }) => new DocCommentRequestError(
          status === 401 || status === 403 ? `${detail} Check page permissions and reconnect Atlassian if scopes are missing.`
            : status === 404 ? 'The requested content is not available on the selected page. Read comments again.' : detail,
          isWrite && status >= 500,
        ),
      }, schema)
    } catch (error) {
      if (error instanceof DocCommentRequestError) throw error
      throw new DocCommentRequestError(!isWrite
        ? 'Could not read Confluence comments. Refresh and try again.'
        : 'Confluence could not confirm the request. Read comments and check the page before sending again.', isWrite)
    }
  }

  private async pages(cloudId: string, path: string, inlineRoots = false): Promise<Comment[]> {
    const result: Comment[] = []
    const cursors = new Set<string>()
    let cursor: string | undefined
    do {
      const query = new URLSearchParams({ 'body-format': 'storage', limit: '250' })
      if (inlineRoots) query.set('resolution-status', 'open,resolved,reopened,dangling')
      if (cursor) query.set('cursor', cursor)
      const page = await this.request(cloudId, `${path}?${query}`, pageSchema)
      result.push(...page.results)
      // Keep the request bound to its original endpoint and site. Only carry the cursor.
      const next = page._links?.next
      cursor = next ? new URL(next, 'https://api.atlassian.com').searchParams.get('cursor') ?? undefined : undefined
      if (next && (!cursor || cursors.has(cursor))) throw new DocCommentRequestError('Confluence returned invalid comment pagination.', false)
      if (cursor) cursors.add(cursor)
    } while (cursor)
    return result
  }

  private async threads(cloudId: string, pageId: string): Promise<Thread[]> {
    const threads: Thread[] = []
    const seen = new Set<string>()
    for (const kind of ['footer', 'inline'] as const) {
      const roots = await this.pages(cloudId, `/wiki/api/v2/pages/${encodeURIComponent(pageId)}/${kind}-comments`, kind === 'inline')
      const loaded = await mapCommentReads(roots, async comment => {
        if (comment.pageId && comment.pageId !== pageId) throw new DocCommentRequestError('Confluence returned a comment from another page.', false)
        const thread: Thread = { kind, comment, replies: [] }
        const queue = [comment]
        for (let index = 0; index < queue.length; index++) {
          const parent = queue[index]!
          const parentKey = key(kind, parent.id)
          if (seen.has(parentKey)) throw new DocCommentRequestError('Confluence returned a repeated comment.', false)
          seen.add(parentKey)
          if (isDeleted(parent)) continue
          const children = await this.pages(cloudId, `/wiki/api/v2/${kind}-comments/${encodeURIComponent(parent.id)}/children`)
          for (const child of children) {
            if ((child.parentCommentId && child.parentCommentId !== parent.id) || (child.pageId && child.pageId !== pageId)) throw new DocCommentRequestError('Confluence returned a reply from another thread.', false)
            thread.replies.push(child)
            queue.push(child)
          }
        }
        return thread
      })
      threads.push(...loaded)
    }
    return threads
  }

  async list(ref: DocRef): Promise<DocCommentThread[]> {
    const cloudId = await this.site(ref, 'read:comment:confluence')
    const threads = await this.threads(cloudId, ref.externalId)
    if (!threads.length) return []
    const page = threads.some(thread => thread.kind === 'inline')
      ? await this.request(cloudId, `/wiki/api/v2/pages/${encodeURIComponent(ref.externalId)}?body-format=storage`, z.object({ body: z.object({ storage: z.object({ value: z.string() }) }) })) : undefined
    const markerQuotes = page ? confluenceMarkerQuotes(page.body.storage.value) : new Map<string, string>()
    const currentUser = await this.request(cloudId, '/wiki/rest/api/user/current', userSchema)
    const originals = new Map<string, OriginalVersion>()
    await mapCommentReads(threads.flatMap(thread => [thread.comment, ...thread.replies].map(comment => ({ kind: thread.kind, comment }))), async ({ kind, comment }) => {
      // Cache only immutable author/time data, after fresh membership and account
      // reads. No cached message or permission can authorize a mutation.
      const cacheKey = JSON.stringify([cloudId, currentUser.accountId, kind, comment.id])
      const original = this.originalVersions.get(cacheKey) ?? (comment.version.number === 1 ? comment.version
        : await this.request(cloudId, `/wiki/api/v2/${kind}-comments/${encodeURIComponent(comment.id)}/versions/1`, versionSchema))
      this.originalVersions.delete(cacheKey)
      this.originalVersions.set(cacheKey, original)
      if (this.originalVersions.size > 1000) this.originalVersions.delete(this.originalVersions.keys().next().value!)
      originals.set(key(kind, comment.id), original)
    })
    const accountIds = [...new Set([...originals.values()].flatMap(version => version.authorId ? [version.authorId] : []))]
    const names = new Map<string, string>()
    for (let index = 0; index < accountIds.length; index += 100) {
      const users = await this.request(cloudId, '/wiki/api/v2/users-bulk', z.object({ results: z.array(userSchema) }), 'POST', { accountIds: accountIds.slice(index, index + 100) })
      for (const user of users.results) names.set(user.accountId, user.displayName ?? user.publicName ?? user.accountId)
    }
    const message = (kind: Kind, comment: Comment) => {
      const original = originals.get(key(kind, comment.id))!
      return {
        id: key(kind, comment.id), text: storageToMarkdown(comment.body?.storage?.value ?? '').markdown,
        author: { name: original.authorId ? names.get(original.authorId) ?? original.authorId : 'Confluence user', isMe: !!original.authorId && original.authorId === currentUser.accountId },
        createdAt: original.createdAt, modifiedAt: comment.version.createdAt, deleted: isDeleted(comment),
      }
    }
    return threads.map(({ kind, comment, replies }) => {
      const anchor = kind === 'inline' ? inlineAnchor(comment, markerQuotes) : undefined
      return {
        allowedActions: threadActions(kind, comment, anchor?.attachmentState),
        textAnchor: anchor,
        ...message(kind, comment), location: kind === 'inline' ? 'inline' as const : 'page' as const,
        attachmentState: anchor?.attachmentState ?? 'unknown', quote: anchor?.quote || comment.properties?.inlineOriginalSelection || '', anchor: comment.properties?.inlineMarkerRef,
        resolved: comment.resolutionStatus === 'resolved', replies: replies.map(reply => message(kind, reply)),
      }
    })
  }

  private async readComment(cloudId: string, kind: Kind, commentId: string): Promise<Comment> {
    const comment = await this.request(cloudId, `/wiki/api/v2/${kind}-comments/${encodeURIComponent(commentId)}?body-format=storage&include-version=true&include-properties=true`, commentSchema)
    if (comment.id !== commentId || isDeleted(comment)) throw new DocCommentRequestError('This comment is not available on the selected page. Read comments again.', false)
    return comment
  }

  private async threadRoot(cloudId: string, pageId: string, threadId: string): Promise<{ kind: Kind; root: Comment }> {
    const match = /^(footer|inline):([^:]+)$/.exec(threadId)
    if (!match) throw new DocCommentRequestError('This thread is not available on the selected page. Read comments again.', false)
    const kind = match[1] === 'inline' ? 'inline' : 'footer'
    const root = await this.readComment(cloudId, kind, match[2]!)
    if (root.pageId !== pageId || root.parentCommentId) throw new DocCommentRequestError('This thread is not available on the selected page. Read comments again.', false)
    return { kind, root }
  }

  private async requireAction(cloudId: string, pageId: string, kind: Kind, root: Comment, action: DocCommentAction): Promise<void> {
    if (kind !== 'inline' && (action === 'resolve' || action === 'reopen')) throw new DocCommentRequestError('Only inline Confluence threads can be resolved or reopened.', false)
    const page = kind === 'inline'
      ? await this.request(cloudId, `/wiki/api/v2/pages/${encodeURIComponent(pageId)}?body-format=storage`, z.object({ body: z.object({ storage: z.object({ value: z.string() }) }) })) : undefined
    const anchor = page ? inlineAnchor(root, confluenceMarkerQuotes(page.body.storage.value)) : undefined
    if (!threadActions(kind, root, anchor?.attachmentState).includes(action)) {
      throw new DocCommentRequestError(anchor?.attachmentState !== 'attached'
        ? 'The inline comment is detached or its anchor cannot be read. Open Confluence to manage it.'
        : 'This action is unavailable for the current thread state. Read comments again.', false)
    }
  }

  /** Walk only the selected reply's ancestors to prove thread membership. */
  private async replyTarget(cloudId: string, pageId: string, kind: Kind, root: Comment, replyId: string): Promise<Comment> {
    const prefix = `${kind}:`
    const failure = () => new DocCommentRequestError('This reply is not part of the selected thread.', false)
    if (!replyId.startsWith(prefix) || replyId === key(kind, root.id)) throw failure()
    const target = await this.readComment(cloudId, kind, replyId.slice(prefix.length))
    const seen = new Set([root.id])
    let current = target
    while (true) {
      if (seen.has(current.id) || (current.pageId && current.pageId !== pageId)) throw failure()
      seen.add(current.id)
      if (current.parentCommentId === root.id) return target
      if (!current.parentCommentId || seen.has(current.parentCommentId)) throw failure()
      current = await this.readComment(cloudId, kind, current.parentCommentId)
    }
  }

  private async create(cloudId: string, pageId: string, text: string, quote?: string): Promise<DocCommentMutationResult> {
    const kind = quote ? 'inline' : 'footer'
    const body: Extract<WriteBody, { pageId: string }> = { pageId, body: { representation: 'storage', value: markdownToStorage(text) } }
    if (quote) {
      const page = await this.request(cloudId, `/wiki/api/v2/pages/${encodeURIComponent(pageId)}?body-format=storage`, z.object({ body: z.object({ storage: z.object({ value: z.string() }) }) }))
      try { requireUniqueConfluenceQuote(page.body.storage.value, quote) }
      catch (error) { throw new DocCommentRequestError(error instanceof Error ? error.message : 'Select a unique passage.', false) }
      body.inlineCommentProperties = { textSelection: quote, textSelectionMatchCount: 1, textSelectionMatchIndex: 0 }
    }
    const created = await this.request(cloudId, `/wiki/api/v2/${kind}-comments`, createdCommentSchema, 'POST', body)
    return { threadId: created?.id ? key(kind, created.id) : undefined }
  }

  async mutate(ref: DocRef, mutation: DocCommentMutation): Promise<DocCommentMutationResult> {
    return withConfluencePage(ref, async () => {
      const cloudId = await this.site(ref, mutation.action === 'delete' ? 'delete:comment:confluence' : 'write:comment:confluence')
      if (mutation.action === 'create') return this.create(cloudId, ref.externalId, mutation.text, mutation.quote)
      await this.site(ref, 'read:comment:confluence')
      const { kind, root } = await this.threadRoot(cloudId, ref.externalId, mutation.threadId)
      if (mutation.action === 'reply') {
        const created = await this.request(cloudId, `/wiki/api/v2/${kind}-comments`, createdCommentSchema, 'POST', { parentCommentId: root.id, body: { representation: 'storage', value: markdownToStorage(mutation.text) } })
        return { threadId: mutation.threadId, replyId: created?.id ? key(kind, created.id) : undefined }
      }
      const target = 'replyId' in mutation && mutation.replyId
        ? await this.replyTarget(cloudId, ref.externalId, kind, root, mutation.replyId) : root
      if ('expectedModifiedAt' in mutation && target.version.createdAt !== mutation.expectedModifiedAt) {
        throw new DocCommentRequestError('The comment changed. Read comments again before editing or deleting it.', false)
      }
      const result = { threadId: mutation.threadId, replyId: 'replyId' in mutation ? mutation.replyId : undefined }
      const path = `/wiki/api/v2/${kind}-comments/${encodeURIComponent(target.id)}`
      if (mutation.action === 'delete') {
        await this.request(cloudId, path, IGNORED_RESPONSE, 'DELETE')
        return result
      }
      await this.requireAction(cloudId, ref.externalId, kind, root, mutation.action)
      const version = { number: target.version.number + 1 }
      if (mutation.action === 'edit') {
        await this.request(cloudId, path, IGNORED_RESPONSE, 'PUT', { version, body: { representation: 'storage', value: markdownToStorage(mutation.text) } })
      } else {
        await this.request(cloudId, path, IGNORED_RESPONSE, 'PUT', { version, resolved: mutation.action === 'resolve' })
      }
      return result
    })
  }
}
