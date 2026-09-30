import { describe, expect, test } from 'bun:test'
import { isRasterImage, mediaTypeFor, mimeTypeFor, videoMimeType } from '@solus/contracts/media-types'

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

// The host, the file pane, and every media surface read this one list, so a
// type shows the same everywhere and a new type is one line.
describe('mediaTypeFor', () => {
  test('names each supported file by kind, ignoring case and directories', () => {
    expect(mediaTypeFor('/repo/Shot.AVIF')).toEqual({ kind: 'image', mime: 'image/avif' })
    expect(mediaTypeFor('icons/app.ico')).toEqual({ kind: 'image', mime: 'image/x-icon' })
    expect(mediaTypeFor('scan.bmp')).toEqual({ kind: 'image', mime: 'image/bmp' })
    expect(mediaTypeFor('docs/spec.pdf')).toEqual({ kind: 'pdf', mime: 'application/pdf' })
    expect(mediaTypeFor('demo.mov')).toEqual({ kind: 'video', mime: 'video/quicktime' })
  })

  test('leaves formats browsers cannot show natively, and text, as non-media', () => {
    expect(mediaTypeFor('IMG_0001.HEIC')).toBeNull()
    expect(mediaTypeFor('photo.tiff')).toBeNull()
    expect(mediaTypeFor('notes.md')).toBeNull()
    expect(mediaTypeFor('a.dir/Makefile')).toBeNull()
    expect(mediaTypeFor('.png')).toBeNull()
  })

  test('SVG is an image but not a raster one, because it can carry script', () => {
    expect(isRasterImage('logo.svg')).toBe(false)
    expect(isRasterImage('logo.webp')).toBe(true)
  })

  test('names text types as well as media types', () => {
    expect(mimeTypeFor('README.md')).toBe('text/markdown')
    expect(mimeTypeFor('clip.webm')).toBe('video/webm')
    expect(mimeTypeFor('main.rs')).toBeUndefined()
  })
})
