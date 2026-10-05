import { z } from 'zod'
import type { Attachment, ModelConfig, PromptOptions, QueuedPromptSnapshot } from './types'

export interface QueueAttachment extends Pick<Attachment, 'id' | 'type' | 'name' | 'mimeType' | 'size'> {
  hostPath?: string
  dataUrl?: string
  /** The exact text context for this file, including design annotations. */
  context?: string
}

export interface QueueEntryDetails {
  kind?: 'prompt' | 'provider_switch'
  provider?: 'claude-code' | 'codex' | 'opencode'
  modelConfig?: ModelConfig
  revision?: number
  held?: boolean
  error?: string
  attachments?: QueueAttachment[]
}

export type SessionQueueMutation =
  | { kind: 'edit'; queueId: string; revision: number; text: string; attachmentContext?: string; attachments?: QueueAttachment[]; images?: PromptOptions['imageAttachments']; imageRefs?: PromptOptions['imageAttachmentRefs'] }
  | { kind: 'remove' | 'steer'; queueId: string; revision: number }
  | { kind: 'move'; queueId: string; revision: number; beforeQueueId: string | null }
  | { kind: 'resume' }
  | { kind: 'switch'; provider: 'claude-code' | 'codex'; modelConfig: ModelConfig }

export interface SessionQueueSnapshot { held: boolean; entries: QueuedPromptSnapshot[] }

export const queueAttachmentSchema: z.ZodType<QueueAttachment> = z.object({
  id: z.string(), type: z.enum(['image', 'file', 'design-selection']), name: z.string(),
  hostPath: z.string().min(1).optional(), dataUrl: z.string().optional(), mimeType: z.string().optional(), size: z.number().nonnegative().optional(),
  context: z.string().optional(),
}).refine((attachment) => !!attachment.hostPath || attachment.type === 'image' && !!attachment.dataUrl, 'An attachment needs a host path or image data.')

const revision = { queueId: z.string().min(1), revision: z.number().int().nonnegative() }
export const sessionQueueMutationSchema: z.ZodType<SessionQueueMutation> = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('edit'), ...revision, text: z.string().min(1), attachmentContext: z.string().optional(),
    attachments: z.array(queueAttachmentSchema).max(8).optional(),
    images: z.array(z.object({ mimeType: z.string(), dataUrl: z.string() })).max(8).optional(),
    imageRefs: z.array(z.object({ mimeType: z.string(), hostPath: z.string(), name: z.string().optional() })).max(8).optional(),
  }),
  z.object({ kind: z.enum(['remove', 'steer']), ...revision }),
  z.object({ kind: z.literal('move'), ...revision, beforeQueueId: z.string().nullable() }),
  z.object({ kind: z.literal('resume') }),
  z.object({ kind: z.literal('switch'), provider: z.enum(['claude-code', 'codex']), modelConfig: z.object({
    modelId: z.string().nullable(), reasoningEffort: z.enum(['none', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra', 'ultracode']),
    contextWindow: z.number().int().positive().nullable(), fastMode: z.boolean(),
  }) }),
])
