import { describe, expect, test } from 'bun:test'
import { videoMimeType } from '@solus/contracts/video'

// Every client and the host decide "is this a video" with this one helper, so
// a picker that lies about a name cannot make a PDF play, and a picker that
// reports no type cannot make a video download.
describe('videoMimeType', () => {
  test('a definite MIME type wins over the extension', () => {
    expect(videoMimeType({ name: 'report.mp4', mimeType: 'application/pdf' })).toBeNull()
    expect(videoMimeType({ name: 'clip.bin', mimeType: 'video/webm' })).toBe('video/webm')
    expect(videoMimeType({ name: 'clip', mimeType: 'Video/MP4; codecs="avc1"' })).toBe('video/mp4')
  })

  test('the extension counts only when the MIME type is empty or generic', () => {
    expect(videoMimeType({ name: 'Screen Recording.MOV' })).toBe('video/quicktime')
    expect(videoMimeType({ name: 'a.m4v', mimeType: '' })).toBe('video/mp4')
    expect(videoMimeType({ name: 'a.webm', mimeType: 'application/octet-stream' })).toBe('video/webm')
    expect(videoMimeType({ name: 'a.txt', mimeType: '' })).toBeNull()
    expect(videoMimeType({ name: 'mp4', mimeType: '' })).toBeNull()
  })
})
