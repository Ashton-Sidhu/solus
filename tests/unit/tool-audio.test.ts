import { describe, expect, test } from 'bun:test'
import { audioPlayedFraction, audioSeekForKey, audioSeekForPointer, formatAudioTime } from '@solus/client-core/tool-audio'

// WHY: the audio of a tool result plays in a Solus player, not the browser's
// own controls, so the keyboard and the pointer must reach every part of the
// clip, and the time must read the same on every client.
describe('the audio player of a tool row', () => {
  test('shows the time as minutes and seconds, and hours when there are some', () => {
    expect(formatAudioTime(0)).toBe('0:00')
    expect(formatAudioTime(7.9)).toBe('0:07')
    expect(formatAudioTime(65)).toBe('1:05')
    expect(formatAudioTime(3729)).toBe('1:02:09')
    expect(formatAudioTime(Number.NaN)).toBe('0:00')
  })

  test('moves the playhead with the arrow keys, page keys, Home, and End, inside the clip', () => {
    expect(audioSeekForKey('ArrowRight', 10, 60)).toBe(15)
    expect(audioSeekForKey('ArrowLeft', 2, 60)).toBe(0)
    expect(audioSeekForKey('ArrowUp', 58, 60)).toBe(60)
    expect(audioSeekForKey('PageUp', 0, 60)).toBe(6)
    expect(audioSeekForKey('Home', 30, 60)).toBe(0)
    expect(audioSeekForKey('End', 30, 60)).toBe(60)
    expect(audioSeekForKey('a', 30, 60)).toBeNull()
    // No duration yet: nothing to seek in.
    expect(audioSeekForKey('ArrowRight', 0, 0)).toBeNull()
  })

  test('seeks to the place of the pointer on the bar, never outside the clip', () => {
    expect(audioSeekForPointer(150, 100, 200, 40)).toBe(10)
    expect(audioSeekForPointer(50, 100, 200, 40)).toBe(0)
    expect(audioSeekForPointer(400, 100, 200, 40)).toBe(40)
    expect(audioPlayedFraction(10, 40)).toBe(0.25)
    expect(audioPlayedFraction(10, 0)).toBe(0)
  })
})
