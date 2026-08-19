import { describe, expect, test } from 'bun:test'
import { cleanVoiceTranscript } from '@solus/server/transcription/clean-transcript'

describe('voice transcript cleanup', () => {
  test.each([
    ['Um, can you fix this?', 'can you fix this?'],
    ['We should, uh, add a test.', 'We should add a test.'],
    ['Um... uh... try again.', 'try again.'],
    ['I erm think we should ship it.', 'I think we should ship it.'],
    ['Well, um, I think so.', 'Well I think so.'],
    ['I think, um.', 'I think.'],
    ['umm uhhh errm', ''],
  ])('removes standalone fillers from %p', (transcript, expected) => {
    expect(cleanVoiceTranscript(transcript)).toBe(expected)
  })

  test.each([
    'Update the umask setting.',
    'That was an uh-oh moment.',
    'Send this to U.M.',
    'I like the current design.',
  ])('preserves meaningful text in %p', (transcript) => {
    expect(cleanVoiceTranscript(transcript)).toBe(transcript)
  })
})
