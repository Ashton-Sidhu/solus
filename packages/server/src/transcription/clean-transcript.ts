const FILLER_WORD =
  /(?:[,;:]\s*)?(?<![\p{L}\p{N}_'-])(?:u+h+|u+m+|e+r+m+)(?![\p{L}\p{N}_'-])(?:\s*(?:[,;:]|\.{2,}))?/giu

/**
 * Remove unambiguous speech fillers without rewriting meaningful words.
 * Hyphenated terms such as "uh-oh" and containing words such as "umask"
 * deliberately do not match.
 */
export function cleanVoiceTranscript(transcript: string): string {
  return transcript
    .replace(FILLER_WORD, ' ')
    .replace(/\s+/g, ' ')
    .replace(/\s+([,.!?;:])/g, '$1')
    .trim()
}
