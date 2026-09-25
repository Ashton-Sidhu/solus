/**
 * Rules for one inline video. Every tab stays mounted, so a transcript can hold
 * many players at once: none of them loads bytes before it is near the
 * viewport, and none keeps playing when its window is hidden.
 */

/** How far outside the viewport a player starts to load its metadata. */
export const VIDEO_PRELOAD_ROOT_MARGIN = '200px'

/** A player loads nothing until it is near the viewport, then only the header:
 *  enough for the first frame and the duration. */
export function videoPreload(isNearViewport: boolean): 'none' | 'metadata' {
  return isNearViewport ? 'metadata' : 'none'
}

/**
 * The source the element plays. A signed URL is renewed while a video plays;
 * swapping it then would restart the stream, so the playing source holds until
 * the video pauses or ends and only then gives way to the latest one.
 */
export function videoPlaybackSource(latestSrc: string | null, playingSrc: string | null): string | null {
  return playingSrc ?? latestSrc
}

/**
 * What a load error means. A held source that has since been renewed has most
 * likely expired, so the player moves to the new URL; the latest URL failing is
 * a real failure.
 */
export function videoErrorOutcome(playingSrc: string | null, latestSrc: string | null): 'use-latest' | 'failed' {
  return playingSrc !== null && latestSrc !== null && playingSrc !== latestSrc ? 'use-latest' : 'failed'
}

/** A hidden window pauses its videos, except the one the user put in
 *  fullscreen, which is still on screen. */
export function shouldPauseWhenHidden(isDocumentHidden: boolean, isFullscreen: boolean): boolean {
  return isDocumentHidden && !isFullscreen
}

/**
 * Where a reloaded source starts. A renewed URL or a retry reloads the element,
 * which resets it to zero; the playhead returns to where the user left it. Null
 * means there is nothing to restore.
 */
export function videoResumeTime(savedTime: number, duration: number): number | null {
  if (!(savedTime > 0) || !Number.isFinite(duration) || duration <= 0) return null
  return Math.min(savedTime, duration)
}

/**
 * The seek that paints a first frame without playing. A `preload="metadata"`
 * video shows black until it has a frame; a tiny seek decodes one. Null when
 * the video has already started, or is anywhere but the very start.
 */
export function videoFirstFrameTime(video: {
  autoplay: boolean
  paused: boolean
  seeking: boolean
  currentTime: number
  duration: number
  playedLength: number
}): number | null {
  if (video.autoplay || !video.paused || video.seeking || video.currentTime !== 0) return null
  if (video.playedLength > 0 || !Number.isFinite(video.duration) || video.duration <= 0) return null
  return Math.min(0.1, video.duration / 2)
}

/** `0:07`, `2:05`, `1:02:03`. Null when the duration is not known. */
export function formatVideoDuration(seconds: number): string | null {
  if (!Number.isFinite(seconds) || seconds < 0) return null
  const total = Math.round(seconds)
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const secs = String(total % 60).padStart(2, '0')
  return hours > 0 ? `${hours}:${String(minutes).padStart(2, '0')}:${secs}` : `${minutes}:${secs}`
}
