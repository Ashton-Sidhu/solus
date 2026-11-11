import type { VoiceModelStatus } from '@solus/contracts/types'

/** What the voice model toast says for one state of the host's voice model. */
export interface VoiceModelToast {
  message: string
  description?: string
  variant: 'info' | 'error'
  /** The download failed, so the toast offers to start it again. */
  canRetry: boolean
}

/**
 * The toast for the state of the voice model, or null when there is nothing to
 * say. A person hears about the model only while the host prepares it or when
 * the download failed: `checking` and `ready` are silent, because dictation
 * either works or will say so itself.
 */
export function voiceModelToast(state: VoiceModelStatus['state'] | null): VoiceModelToast | null {
  switch (state) {
    case 'downloading':
      return { message: 'Downloading voice model', description: 'You can keep typing.', variant: 'info', canRetry: false }
    case 'installing':
      return { message: 'Installing voice model', description: 'You can keep typing.', variant: 'info', canRetry: false }
    case 'error':
      return { message: 'Voice model download failed', variant: 'error', canRetry: true }
    default:
      return null
  }
}
