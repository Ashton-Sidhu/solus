import { DocCommentRequestError } from '../docs/types'
import { z } from 'zod'
import type { GoogleCommentThread } from '@solus/contracts/work-comments'
import { Parser } from 'htmlparser2'
import { driveApi, googleAnswer } from './google-api'

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

const REQUEST_TIMEOUT_MS = 25_000

/** A write whose answer never came is uncertain: Google may have applied it. */
async function request<T>(isWrite: boolean, call: Promise<{ data: T }>): Promise<T> {
  const answer = await googleAnswer(call)
  if (answer.kind === 'answered') return answer.data
  if (answer.kind === 'unanswered') throw new GoogleCommentRequestError('Google could not confirm the request. Check the document before sending again.', isWrite)
  throw new GoogleCommentRequestError(`Google comments request failed (${answer.status}). Check the connection and document permissions.`, isWrite && answer.status >= 500)
}

/** All pages must succeed before the caller replaces its cached snapshot. */
export async function listGoogleComments(token: string, documentId: string): Promise<GoogleCommentThread[]> {
  const comments: GoogleCommentThread[] = []
  const seen = new Set<string>()
  let pageToken: string | undefined
  const drive = driveApi(token, REQUEST_TIMEOUT_MS)
  do {
    const listed = drive.comments.list({ fileId: documentId, fields: `nextPageToken,comments(${fields})`, includeDeleted: true, pageSize: 100, pageToken })
    const page = pageSchema.parse(await request(false, listed))
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
  return acknowledgedId(await request(true, driveApi(token, REQUEST_TIMEOUT_MS).comments.create({ fileId: documentId, fields: 'id', requestBody: body })))
}

export async function postGoogleReply(token: string, documentId: string, threadId: string, body: { content?: string; action?: 'resolve' | 'reopen' }): Promise<string | undefined> {
  return acknowledgedId(await request(true, driveApi(token, REQUEST_TIMEOUT_MS).replies.create({ fileId: documentId, commentId: threadId, fields: 'id', requestBody: body })))
}

/** A successful write remains acknowledged even if its optional ID cannot be read. */
function acknowledgedId(answer: { id?: string | null }): string | undefined {
  return answer.id ?? undefined
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
  const drive = driveApi(token, REQUEST_TIMEOUT_MS)
  const target = { fileId: documentId, commentId: threadId }
  if (change.kind === 'edit') {
    const requestBody = { content: change.text }
    await request(true, change.replyId
      ? drive.replies.update({ ...target, replyId: change.replyId, fields: 'id', requestBody })
      : drive.comments.update({ ...target, fields: 'id', requestBody }))
  } else {
    await request(true, change.replyId ? drive.replies.delete({ ...target, replyId: change.replyId }) : drive.comments.delete(target))
  }
}
