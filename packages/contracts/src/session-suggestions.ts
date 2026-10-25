import { z } from 'zod'

/**
 * A suggestion (docs/plans/custom-roles.md §7): a message a person who may only
 * propose sends to a session. It waits until someone who may prompt the session
 * sends it as their own turn, prefixed with who wrote it, or dismisses it. Its
 * author can withdraw it while it waits.
 */
export const SUGGESTION_TEXT_MAX = 4000
/** Waiting suggestions one author may have on one session. */
export const SUGGESTIONS_WAITING_MAX = 3

/** A file uploaded to the session (`attachUpload`) for this suggestion. The host checks the path is in the session's own uploads. */
export const suggestionAttachmentSchema = z.object({
  name: z.string().min(1).max(255),
  mimeType: z.string().min(1).max(127),
  hostPath: z.string().min(1).max(4096),
})
export type SuggestionAttachment = z.infer<typeof suggestionAttachmentSchema>

export const sessionSuggestRequestSchema = z.object({
  text: z.string().trim().min(1).max(SUGGESTION_TEXT_MAX),
  attachments: z.array(suggestionAttachmentSchema).max(4).default([]),
})
export type SessionSuggestRequest = z.input<typeof sessionSuggestRequestSchema>

export type SuggestionState = 'waiting' | 'sent' | 'dismissed' | 'withdrawn'

export interface SessionSuggestion {
  id: string
  sessionId: string
  /** Who wrote it, as they named themselves. */
  authorName: string
  /** Whether the caller wrote it: only its author may withdraw it. */
  isMine: boolean
  text: string
  attachments: SuggestionAttachment[]
  state: SuggestionState
  createdAt: number
  /** Who sent or dismissed it. */
  decidedByName?: string
}

export type SuggestionDecision = 'send' | 'dismiss'
export const suggestionDecisionSchema = z.enum(['send', 'dismiss'])

/** The line a sent suggestion starts with, so the agent and the transcript say who wrote it and who sent it. */
export function suggestionPrompt(text: string, authorName: string, senderName: string): string {
  return `Message from guest ${authorName}, sent by ${senderName}:\n\n${text}`
}
