export type { DocCommentThread } from './work-comments'

export type DocCommentAction = 'create' | 'reply' | 'edit' | 'delete' | 'resolve' | 'reopen'

export type DocCommentMutation =
  | { action: 'create'; text: string; quote?: string }
  | { action: 'reply'; threadId: string; text: string }
  | { action: 'edit'; threadId: string; replyId?: string; text: string; expectedModifiedAt: string }
  | { action: 'delete'; threadId: string; replyId?: string; expectedModifiedAt: string }
  | { action: 'resolve' | 'reopen'; threadId: string }

/** IDs acknowledged by the provider; absent when its response has no ID. */
export interface DocCommentMutationResult { threadId?: string; replyId?: string }
