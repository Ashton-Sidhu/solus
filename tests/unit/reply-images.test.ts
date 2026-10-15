import { describe, expect, test } from 'bun:test'
import { imageFileChips, messageReplyImages, replyImages } from '@solus/client-core/reply-images'

describe('reply image cards', () => {
  test('finds image embeds and file links without treating video embeds as images', () => {
    const reply = replyImages('Ready. ![Screenshot](</work/my screen.png>)\n[Download](result.webp)\n![Demo](demo.mp4)')
    expect(reply.map((image) => image.href)).toEqual(['/work/my screen.png', 'result.webp'])
    expect(reply[0]?.label).toBe('my screen.png')
  })

  test('extracts references and nested images without removing identical code examples', () => {
    const source = '`![shot](a.png)`\n\n> ![shot](a.png)\n\n![Other][picture]\n\n[picture]: /work/b.png'
    const result = replyImages(source)
    expect(result.map((image) => image.href)).toEqual(['a.png', '/work/b.png'])
  })

  test('accepts the absolute paths with spaces agents use on macOS', () => {
    const result = replyImages('See ![shot](/Users/me/Application Support/screen.png).')
    expect(result[0]?.href).toBe('/Users/me/Application Support/screen.png')
  })

  test('does not claim an incomplete streamed image', () => {
    expect(replyImages('![loading](image.png')).toEqual([])
  })

  test('reuses settled message parsing and refreshes a mutable streamed message', () => {
    const message = { content: '![First](a.png)' }
    const first = messageReplyImages(message)
    expect(messageReplyImages(message)).toBe(first)
    message.content += ' ![Next](b.png)'
    expect(messageReplyImages(message)).toHaveLength(2)
    expect(first).toHaveLength(1)
  })
})

describe('assistant image file chips', () => {
  test('replaces image embeds with file links while leaving videos and ordinary links intact', () => {
    expect(imageFileChips('See ![Shot](/work/screen.png), [notes](notes.md), and ![Demo](demo.mp4).'))
      .toBe('See [screen.png](</work/screen.png>), [notes](notes.md), and ![Demo](demo.mp4).')
  })

  test('uses source positions so code examples never become chips', () => {
    expect(imageFileChips('`![Shot](screen.png)`\n\n![Shot](screen.png)'))
      .toBe('`![Shot](screen.png)`\n\n[screen.png](<screen.png>)')
  })

  test('supports reference embeds, nested content, and host paths with spaces', () => {
    expect(imageFileChips('> ![Shot][shot]\n\n![Other](/Users/me/Application Support/other.png)\n\n[shot]: /work/screen.png'))
      .toBe('> [screen.png](</work/screen.png>)\n\n[other.png](</Users/me/Application Support/other.png>)\n\n[shot]: /work/screen.png')
  })

  test('preserves incomplete streaming syntax and keeps image references available to the gallery', () => {
    const source = '![Shot](https://example.com/screen.png)'
    expect(imageFileChips('![Shot](screen.png')).toBe('![Shot](screen.png')
    expect(replyImages(imageFileChips(source))).toEqual(replyImages(source))
  })
})
