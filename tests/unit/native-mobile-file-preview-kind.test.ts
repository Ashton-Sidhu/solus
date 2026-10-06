import { describe, expect, test } from 'bun:test'
import { fileMediaView, isMarkdownFile, resolveMarkdownRelativePath } from '../../apps/mobile/src/features/files/lib/file-preview-kind'

describe('native file preview kind', () => {
  test('shows raster images and video inline, and opens SVG and PDF in the browser', () => {
    // WHY: React Native draws raster images only; an SVG or a PDF in an image
    // view would render nothing.
    expect(fileMediaView('/repo/shot.PNG')).toBe('image')
    expect(fileMediaView('/repo/clip.mov')).toBe('video')
    expect(fileMediaView('/repo/logo.svg')).toBe('document')
    expect(fileMediaView('/repo/spec.pdf')).toBe('document')
    expect(fileMediaView('/repo/voice.m4a')).toBe('audio')
    expect(fileMediaView('/repo/src/index.ts')).toBeNull()
  })

  test('recognizes Markdown files for the preview mode', () => {
    expect(isMarkdownFile('docs/README.md')).toBe(true)
    expect(isMarkdownFile('notes.markdown')).toBe(true)
    expect(isMarkdownFile('src/md.ts')).toBe(false)
  })

  test('resolves Markdown links next to the file and keeps host-absolute paths', () => {
    expect(resolveMarkdownRelativePath('docs/guide/README.md', 'img/a.png')).toBe('docs/guide/img/a.png')
    expect(resolveMarkdownRelativePath('docs/guide/README.md', '../shared/b.png')).toBe('docs/shared/b.png')
    expect(resolveMarkdownRelativePath('docs/guide/README.md', './c.md')).toBe('docs/guide/c.md')
    expect(resolveMarkdownRelativePath('README.md', '../outside.png')).toBe('../outside.png')
    expect(resolveMarkdownRelativePath('docs/README.md', '/abs/d.png')).toBe('/abs/d.png')
    expect(resolveMarkdownRelativePath('docs/README.md', '~/e.png')).toBe('~/e.png')
  })
})
