import { DocCommentRequestError } from '../docs/types'
import { z } from 'zod'
import type { GoogleCommentThread } from '@solus/contracts/work-comments'
import { Parser } from 'htmlparser2'

function quoteText(html: string): string {
  let text = ''
  const parser = new Parser({ ontext: value => { text += value }, onopentag: name => { if (name === 'br') text += '\n' } }, { decodeEntities: true })
  parser.end(html)
  return text
}

const authorSchema = z.object({ displayName: z.string().optional(), me: z.boolean().optional() })
const replySchema = z.object({
  id: z.string(), content: z.string().optional(), author: authorSchema.optional(),
  createdTime: z.string(), modifiedTime: z.string(), deleted: z.boolean().optional(),
  action: z.enum(['resolve', 'reopen']).optional(),
})
const commentSchema = z.object({
  id: z.string(), content: z.string().optional(), author: authorSchema.optional(),
  createdTime: z.string(), modifiedTime: z.string(), deleted: z.boolean().optional(),
  resolved: z.boolean().optional(), anchor: z.string().optional(),
  quotedFileContent: z.object({ value: z.string().optional(), mimeType: z.string().optional() }).optional(),
  replies: z.array(replySchema).optional(),
})
const pageSchema = z.object({ comments: z.array(commentSchema).optional(), nextPageToken: z.string().optional() })
const fields = 'id,content,author(displayName,me),createdTime,modifiedTime,deleted,resolved,anchor,quotedFileContent,replies(id,content,author(displayName,me),createdTime,modifiedTime,deleted,action)'

export class GoogleCommentRequestError extends DocCommentRequestError {}

interface GoogleCommentRequestBody {
  content?: string
  action?: 'resolve' | 'reopen'
  quotedFileContent?: { mimeType: 'text/plain'; value: string }
}

async function request(token: string, url: string, body?: GoogleCommentRequestBody, method = body ? 'POST' : 'GET'): Promise<Response> {
  let response: Response
  try {
    const options: RequestInit = {
      method,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(25_000),
    }
    if (body) options.body = JSON.stringify(body)
    response = await fetch(url, options)
  } catch {
    throw new GoogleCommentRequestError('Google could not confirm the request. Check the document before sending again.', method !== 'GET')
  }
  if (!response.ok) {
    throw new GoogleCommentRequestError(`Google comments request failed (${response.status}). Check the connection and document permissions.`, method !== 'GET' && response.status >= 500)
  }
  return response
}

function base(documentId: string): string {
  return `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(documentId)}/comments`
}

/** All pages must succeed before the caller replaces its cached snapshot. */
export async function listGoogleComments(token: string, documentId: string): Promise<GoogleCommentThread[]> {
  const comments: GoogleCommentThread[] = []
  const seen = new Set<string>()
  let pageToken: string | undefined
  do {
    const params = new URLSearchParams({ fields: `nextPageToken,comments(${fields})`, includeDeleted: 'true', pageSize: '100' })
    if (pageToken) params.set('pageToken', pageToken)
    const page = pageSchema.parse(await (await request(token, `${base(documentId)}?${params}`)).json())
    for (const comment of page.comments ?? []) {
      comments.push(normalizeComment(comment))
    }
    pageToken = page.nextPageToken
    if (pageToken && seen.has(pageToken)) throw new Error('Google returned a repeated comment page. Refresh again.')
    if (pageToken) seen.add(pageToken)
  } while (pageToken)
  return comments
}

export async function postGoogleComment(token: string, documentId: string, text: string, quote?: string): Promise<string | undefined> {
  const body: GoogleCommentRequestBody = { content: text }
  if (quote) body.quotedFileContent = { mimeType: 'text/plain', value: quote }
  return acknowledgedId(await request(token, `${base(documentId)}?fields=id`, body))
}

export async function postGoogleReply(token: string, documentId: string, threadId: string, body: { content?: string; action?: 'resolve' | 'reopen' }): Promise<string | undefined> {
  return acknowledgedId(await request(token, `${base(documentId)}/${encodeURIComponent(threadId)}/replies?fields=id`, body))
}

async function acknowledgedId(response: Response): Promise<string | undefined> {
  // A successful write remains acknowledged even if its optional ID cannot be read.
  const parsed = z.object({ id: z.string() }).safeParse(await response.json().catch(() => undefined))
  return parsed.success ? parsed.data.id : undefined
}

function normalizeComment(comment: z.infer<typeof commentSchema>): GoogleCommentThread {
  const quote = comment.quotedFileContent
  return {
    id: comment.id, text: comment.content ?? '',
    quote: quote?.mimeType === 'text/html' ? quoteText(quote.value ?? '') : quote?.value ?? '',
    anchor: comment.anchor,
    author: { name: comment.author?.displayName ?? 'Google user', isMe: comment.author?.me ?? false },
    createdAt: comment.createdTime, modifiedAt: comment.modifiedTime,
    deleted: comment.deleted ?? false, resolved: comment.resolved ?? false,
    replies: (comment.replies ?? []).map(reply => ({
      id: reply.id, text: reply.content ?? '',
      author: { name: reply.author?.displayName ?? 'Google user', isMe: reply.author?.me ?? false },
      createdAt: reply.createdTime, modifiedAt: reply.modifiedTime,
      deleted: reply.deleted ?? false, action: reply.action,
    })),
  }
}

/** Edit or delete one message; Google remains the final authority on permissions. */
export async function changeGoogleCommentMessage(
  token: string, documentId: string, threadId: string,
  change: { kind: 'edit'; text: string; replyId?: string } | { kind: 'delete'; replyId?: string },
): Promise<void> {
  const url = `${base(documentId)}/${encodeURIComponent(threadId)}${change.replyId ? `/replies/${encodeURIComponent(change.replyId)}` : ''}`
  await request(token, `${url}?fields=id`, change.kind === 'edit' ? { content: change.text } : undefined,
    change.kind === 'edit' ? 'PATCH' : 'DELETE')
}
