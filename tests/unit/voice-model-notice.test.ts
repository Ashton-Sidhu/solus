import { expect, test } from 'bun:test'
import { voiceModelToast } from '../../packages/workspace-ui/src/components/input/lib/voice-model-toast'

test('a person hears about the voice model only while the host prepares it or after a failed download', () => {
  // Dictation works without a word when the model is ready, and a host that
  // still checks has nothing to report: a toast then is noise on every start.
  expect(voiceModelToast('checking')).toBeNull()
  expect(voiceModelToast('ready')).toBeNull()
  // A host with no voice model capability, or no transcription host.
  expect(voiceModelToast(null)).toBeNull()

  expect(voiceModelToast('downloading')).toMatchObject({ message: 'Downloading voice model', variant: 'info', canRetry: false })
  expect(voiceModelToast('installing')).toMatchObject({ message: 'Installing voice model', variant: 'info', canRetry: false })
})

test('only a failed download offers Retry', () => {
  // Retry starts the download again; while one runs, a second start is wrong.
  expect(voiceModelToast('error')).toEqual({ message: 'Voice model download failed', variant: 'error', canRetry: true })
})
