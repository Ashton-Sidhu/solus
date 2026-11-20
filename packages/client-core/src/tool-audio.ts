// The audio player of a tool row, on desktop, web, and mobile: its time and its seek rules.

/** How far one arrow key moves the playhead of a tool row's audio, in seconds. */
export const AUDIO_SEEK_STEP_SECONDS = 5

/** A clip's time as the player shows it: "0:07", "1:05", "1:02:09". Unknown is "0:00". */
export function formatAudioTime(seconds: number): string {
  const whole = Number.isFinite(seconds) && seconds > 0 ? Math.floor(seconds) : 0
  const hours = Math.floor(whole / 3600)
  const minutes = Math.floor((whole % 3600) / 60)
  const rest = String(whole % 60).padStart(2, '0')
  return hours > 0 ? `${hours}:${String(minutes).padStart(2, '0')}:${rest}` : `${minutes}:${rest}`
}

/** The playhead after a key on the seek bar, or null when the key does not seek. */
export function audioSeekForKey(key: string, current: number, duration: number): number | null {
  if (!Number.isFinite(duration) || duration <= 0) return null
  const clamp = (value: number) => Math.min(duration, Math.max(0, value))
  switch (key) {
    case 'ArrowLeft':
    case 'ArrowDown':
      return clamp(current - AUDIO_SEEK_STEP_SECONDS)
    case 'ArrowRight':
    case 'ArrowUp':
      return clamp(current + AUDIO_SEEK_STEP_SECONDS)
    case 'PageDown':
      return clamp(current - duration / 10)
    case 'PageUp':
      return clamp(current + duration / 10)
    case 'Home':
      return 0
    case 'End':
      return duration
    default:
      return null
  }
}

/** The playhead for a pointer at `clientX` on a seek bar that spans `left` to `left + width`. */
export function audioSeekForPointer(clientX: number, left: number, width: number, duration: number): number {
  if (width <= 0 || !Number.isFinite(duration) || duration <= 0) return 0
  return Math.min(1, Math.max(0, (clientX - left) / width)) * duration
}

/** How much of the clip has played, from 0 to 1. */
export function audioPlayedFraction(current: number, duration: number): number {
  return Number.isFinite(duration) && duration > 0 ? Math.min(1, Math.max(0, current / duration)) : 0
}
