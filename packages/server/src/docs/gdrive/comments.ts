import type { DocCommentMutationResult, DocCommentMutation, DocCommentThread } from '@solus/contracts/doc-comments'
import type { DocRef } from '@solus/contracts/docs'
import { getAccessToken } from '../../google/oauth'
import { changeGoogleCommentMessage, listGoogleComments, postGoogleComment, postGoogleReply } from '../../google/comments'
import { DocCommentRequestError, type DocCommentsAdapter } from '../types'

export class GoogleDocComments implements DocCommentsAdapter {
  readonly actions = ['create', 'reply', 'edit', 'delete', 'resolve', 'reopen'] as const
  readonly limitations = [
    'New comments quote text but cannot create native document highlights.',
    'Only messages owned by the connected account can be edited or deleted.',
    'Write access is required; read access alone is insufficient.',
    'Edit/delete checks the last read modification time, but Google provides no atomic comment write precondition.',
  ]

  private async token(ref: DocRef): Promise<string> {
    if (ref.provider !== 'gdrive') throw new DocCommentRequestError('This document is not a Google Doc.', false)
    const token = await getAccessToken()
    if (!token) throw new DocCommentRequestError('Connect Google in Settings to use document comments.', false)
    return token
  }

  async list(ref: DocRef): Promise<DocCommentThread[]> {
    const threads = await listGoogleComments(await this.token(ref), ref.externalId)
    return threads.map(thread => ({
      ...thread,
      allowedActions: thread.deleted ? [] : [
        'reply' as const, thread.resolved ? 'reopen' as const : 'resolve' as const,
        ...(thread.author.isMe ? ['edit' as const, 'delete' as const] : []),
      ],
      textAnchor: thread.quote ? { quote: thread.quote, attachmentState: 'unknown' as const } : undefined,
    }))
  }

  async mutate(ref: DocRef, mutation: DocCommentMutation): Promise<DocCommentMutationResult> {
    const token = await this.token(ref)
    if (mutation.action === 'create') {
      return { threadId: await postGoogleComment(token, ref.externalId, mutation.text, mutation.quote) }
    }
    const threads = await listGoogleComments(token, ref.externalId)
    const thread = threads.find(thread => thread.id === mutation.threadId && !thread.deleted)
    if (!thread) throw new DocCommentRequestError('The external thread is no longer available. Read comments again.', false)
    if (mutation.action === 'edit' || mutation.action === 'delete') {
      const message = mutation.replyId ? thread.replies.find(reply => reply.id === mutation.replyId && !reply.deleted) : thread
      if (!message) throw new DocCommentRequestError('The external reply is no longer available. Read comments again.', false)
      if (!message.author.isMe) throw new DocCommentRequestError('Only the author can edit or delete this message.', false)
      if (message.modifiedAt !== mutation.expectedModifiedAt) throw new DocCommentRequestError('The message changed. Read comments again before editing or deleting it.', false)
      await changeGoogleCommentMessage(token, ref.externalId, thread.id,
        mutation.action === 'edit' ? { kind: 'edit', text: mutation.text, replyId: mutation.replyId } : { kind: 'delete', replyId: mutation.replyId })
    } else {
      const replyId = await postGoogleReply(token, ref.externalId, thread.id,
        mutation.action === 'reply' ? { content: mutation.text } : { action: mutation.action })
      return { threadId: thread.id, replyId }
    }
    return { threadId: thread.id, replyId: mutation.replyId }
  }
}
