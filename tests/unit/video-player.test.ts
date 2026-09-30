import { describe, expect, test } from 'bun:test'
import {
  formatVideoDuration,
  shouldPauseWhenHidden,
  videoErrorOutcome,
  videoFirstFrameTime,
  videoPlaybackSource,
  videoPreload,
  videoResumeTime,
} from '@solus/workspace-ui/components/ui/video-player/video-player'
import { isVideoAttachment, videoAttachmentPath } from '@solus/workspace-ui/lib/video-attachment'
import { uploadProgressPercent } from '@solus/workspace-ui/components/input/lib/attachment-upload'

describe('video player', () => {
  test('loads nothing until it is near the viewport, then only metadata', () => {
    // WHY: every tab stays mounted, so a transcript of recordings would fetch
    // them all at once if a hidden player preloaded.
    expect(videoPreload(false)).toBe('none')
    expect(videoPreload(true)).toBe('metadata')
  })

  test('a renewed URL waits while the video plays and takes over once it pauses', () => {
    // WHY: swapping the source mid-play restarts the stream under the user.
    const playing = 'https://host/api/assets/old'
    const renewed = 'https://host/api/assets/new'
    expect(videoPlaybackSource(renewed, playing)).toBe(playing)
    expect(videoPlaybackSource(renewed, null)).toBe(renewed)
    expect(videoPlaybackSource(null, null)).toBeNull()
  })

  test('an error on a held URL moves to the renewed one; an error on the latest is a failure', () => {
    expect(videoErrorOutcome('https://host/old', 'https://host/new')).toBe('use-latest')
    expect(videoErrorOutcome(null, 'https://host/new')).toBe('failed')
    expect(videoErrorOutcome('https://host/new', 'https://host/new')).toBe('failed')
  })

  test('a reloaded source returns to where the user left it', () => {
    expect(videoResumeTime(12.5, 30)).toBe(12.5)
    expect(videoResumeTime(0, 30)).toBeNull()
    expect(videoResumeTime(40, 30)).toBe(30)
    expect(videoResumeTime(5, Number.NaN)).toBeNull()
  })

  test('a hidden window pauses its videos unless one is fullscreen', () => {
    expect(shouldPauseWhenHidden(true, false)).toBe(true)
    expect(shouldPauseWhenHidden(true, true)).toBe(false)
    expect(shouldPauseWhenHidden(false, false)).toBe(false)
  })

  test('seeks for a first frame only at the very start of an unplayed video', () => {
    const fresh = { autoplay: false, paused: true, seeking: false, currentTime: 0, duration: 8, playedLength: 0 }
    expect(videoFirstFrameTime(fresh)).toBe(0.1)
    expect(videoFirstFrameTime({ ...fresh, duration: 0.1 })).toBe(0.05)
    expect(videoFirstFrameTime({ ...fresh, currentTime: 3 })).toBeNull()
    expect(videoFirstFrameTime({ ...fresh, playedLength: 1 })).toBeNull()
    expect(videoFirstFrameTime({ ...fresh, duration: Number.POSITIVE_INFINITY })).toBeNull()
  })

  test('formats a duration for the chip', () => {
    expect(formatVideoDuration(7.4)).toBe('0:07')
    expect(formatVideoDuration(125)).toBe('2:05')
    expect(formatVideoDuration(3723)).toBe('1:02:03')
    expect(formatVideoDuration(Number.NaN)).toBeNull()
  })
})

describe('video attachments', () => {
  test('a video is recognised by type or, when the type is generic, by name', () => {
    expect(isVideoAttachment({ type: 'file', name: 'bug.mp4', mimeType: 'video/mp4' })).toBe(true)
    expect(isVideoAttachment({ type: 'file', name: 'bug.mov', mimeType: 'application/octet-stream' })).toBe(true)
    expect(isVideoAttachment({ type: 'file', name: 'spec.mp4', mimeType: 'application/pdf' })).toBe(false)
    expect(isVideoAttachment({ type: 'image', name: 'shot.png', mimeType: 'image/png' })).toBe(false)
  })

  test('a streamed upload has no playable path until its bytes land', () => {
    // WHY: before the upload finishes `path` is only the file name; resolving it
    // on the host would fail or find another file.
    expect(videoAttachmentPath({ path: 'bug.mp4' })).toBeNull()
    expect(videoAttachmentPath({ path: 'bug.mp4', hostPath: '/srv/attachments/s/0-bug.mp4' })).toBe('/srv/attachments/s/0-bug.mp4')
    expect(videoAttachmentPath({ path: '/Users/me/bug.mp4' })).toBe('/Users/me/bug.mp4')
  })

  test('upload progress never reads 100% before the host answers', () => {
    expect(uploadProgressPercent(50, 100)).toBe(50)
    expect(uploadProgressPercent(100, 100)).toBe(99)
    expect(uploadProgressPercent(0, 0)).toBe(0)
  })
})
