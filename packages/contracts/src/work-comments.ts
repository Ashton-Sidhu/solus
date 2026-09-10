import type { DocCommentAction, DocCommentMutationResult } from './doc-comments'
import type { DocProviderId } from './docs'
/** External discussions are separate from private agent instructions. */
export interface DocCommentAuthor {
  name: string
  isMe: boolean
}

export interface DocCommentReply {
  id: string
  text: string
  author: DocCommentAuthor
  createdAt: string
  modifiedAt: string
  deleted: boolean
  action?: 'resolve' | 'reopen'
}

export interface DocCommentThread {
  /** Supported operations on this thread, not a permission grant. Absent in legacy snapshots. */
  allowedActions?: DocCommentAction[]
  textAnchor?: { quote: string; attachmentState: 'attached' | 'detached' | 'unknown' }
  /** Provider thread location; absent for older snapshots. */
  location?: 'page' | 'inline'
  /** A detached inline selection is distinct from a resolved discussion. */
  attachmentState?: 'attached' | 'detached' | 'unknown'
  id: string
  text: string
  quote: string
  /** Opaque provider value; native Docs anchors are not JSON. */
  anchor?: string
  author: DocCommentAuthor
  createdAt: string
  modifiedAt: string
  resolved: boolean
  deleted: boolean
  replies: DocCommentReply[]
}

/** Compatibility names for the Google RPC and persisted snapshot. */
export type GoogleCommentAuthor = DocCommentAuthor
export type GoogleCommentReply = DocCommentReply

export interface CommentDocumentTarget {
  provider: DocProviderId
  documentId: string
  externalKey: string
}

export type ExternalCommentCommand = (
  | { kind: 'share'; requestId: string; text: string; quote?: string; sourceMessageId?: string }
  | { kind: 'reply'; requestId: string; threadId: string; text: string }
  | { kind: 'resolve' | 'reopen'; requestId: string; threadId: string }
) & { target?: CommentDocumentTarget }

export interface ExternalCommentOperation {
  requestId: string
  command: ExternalCommentCommand
  status: 'sending' | 'sent' | 'uncertain' | 'failed'
  result?: DocCommentMutationResult
  error?: string
}

export interface WorkExternalComments {
  capabilities?: { actions: readonly DocCommentAction[]; limitations: string[] }
  provider: DocProviderId
  externalKey: string
  documentId: string
  threads: DocCommentThread[]
  operations: ExternalCommentOperation[]
  checkedAt?: number
  error?: string
}

/** Older hosts and snapshots use these Google-only names. */
export type GoogleCommentThread = DocCommentThread
export type GoogleCommentCommand = ExternalCommentCommand
export type GoogleCommentOperation = ExternalCommentOperation
export type WorkGoogleComments = Omit<WorkExternalComments, 'provider' | 'externalKey'>
