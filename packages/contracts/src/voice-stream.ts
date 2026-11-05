import { z } from 'zod'

export interface VoiceTranscript {
  error: string | null
  transcript: string | null
}

export interface VoicePartial {
  stable: string
  tentative: string
}

export const voiceStreamIdSchema = z.object({ streamId: z.string().uuid() })
export const voiceStreamFeedSchema = voiceStreamIdSchema.extend({
  // At most one second per call. Arrays have the same representation on IPC
  // and WebSocket; a Float32Array would become an object in JSON.
  samples: z.array(z.number().finite().min(-1).max(1)).min(1).max(16_000),
})
export type VoiceStreamRequest = z.infer<typeof voiceStreamIdSchema>
export type VoiceStreamFeedRequest = z.infer<typeof voiceStreamFeedSchema>
