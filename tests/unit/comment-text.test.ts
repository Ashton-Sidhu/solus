import { describe, expect, test } from 'bun:test'
import { parseCommentText, parseInline } from '@solus/workspace-ui/components/comments/lib/comment-text'
import {
  isUnread,
  showsAuthor,
  visibleReplies,
} from '@solus/workspace-ui/components/comments/lib/thread'
import { threadTime } from '@solus/workspace-ui/lib/relative-time'
import type { PlanComment } from '@solus/contracts/types'

// Comment prose is deliberately poorer than the document's. A thread that can
// grow headings and tables stops being a margin note, so the tokenizer is an
// allowlist: what it doesn't recognise stays the literal characters the author
// typed rather than silently becoming structure.

describe('comment text', () => {
  test('carries the inline set a note actually needs', () => {
    const segments = parseInline('**pick one** and `codemod` the rest, @mira — see [the table](https://x.dev/t)')
    expect(segments.map((s) => s.kind)).toEqual([
      'bold',
      'plain',
      'code',
      'plain',
      'mention',
      'plain',
      'link',
    ])
    expect(segments.find((s) => s.kind === 'mention')).toEqual({ kind: 'mention', text: '@mira' })
    expect(segments.find((s) => s.kind === 'link')).toEqual({
      kind: 'link',
      text: 'the table',
      href: 'https://x.dev/t',
    })
  })

  test('inline code wins, so markup inside backticks stays literal', () => {
    const segments = parseInline('use `**not bold** @notamention` here')
    expect(segments.map((s) => s.kind)).toEqual(['plain', 'code', 'plain'])
    expect(segments[1].text).toBe('**not bold** @notamention')
  })

  test('bold beats italic on the same asterisks', () => {
    expect(parseInline('**both**')).toEqual([{ kind: 'bold', text: 'both' }])
    expect(parseInline('_one_')).toEqual([{ kind: 'italic', text: 'one' }])
  })

  test('a leading > is a one-line code quote', () => {
    const blocks = parseCommentText('as you said:\n> rounded-full ×181')
    expect(blocks[0].kind).toBe('text')
    expect(blocks[1]).toEqual({ kind: 'quote', text: 'rounded-full ×181' })
  })

  test('what a comment is not allowed to be stays literal text', () => {
    // Headings, tables, remote images and nested quotes stay out of margin notes.
    for (const source of ['# Heading', '| a | b |', '![alt](https://x.dev/i.png)', '>> nested']) {
      const blocks = parseCommentText(source)
      expect(blocks).toHaveLength(1)
      expect(blocks[0].kind).toBe('text')
      const rendered = blocks[0].kind === 'text' ? blocks[0].segments.map((s) => s.text).join('') : ''
      expect(rendered).toBe(source)
    }
  })

  test('recognizes a content-addressed pasted image', () => {
    const id = `${'a'.repeat(64)}.png`
    expect(parseInline(`before ![screen](asset://${id}) after`)).toEqual([
      { kind: 'plain', text: 'before ' },
      { kind: 'image', text: 'screen', href: `asset://${id}` },
      { kind: 'plain', text: ' after' },
    ])
  })

  test('recognizes a content-addressed general attachment', () => {
    const href = `asset://${'b'.repeat(64)}.pdf`
    expect(parseInline(`[brief.pdf](${href})`)).toEqual([
      { kind: 'link', text: 'brief.pdf', href },
    ])
  })
})

describe('threads', () => {
  const at = (createdAt: number, author: 'you' | 'solus' = 'you') => ({
    id: `r${createdAt}`,
    author,
    text: 't',
    createdAt,
  })

  test('two replies show, the rest become a count', () => {
    // SAFETY: visibleReplies reads only the replies populated by this fixture.
    const comment = { replies: [at(1), at(2), at(3), at(4)] } as PlanComment
    const { earlierCount, shown } = visibleReplies(comment)
    expect(earlierCount).toBe(2)
    // The last two, not the first — a thread is caught up on from the bottom.
    expect(shown.map((r) => r.createdAt)).toEqual([3, 4])
  })

  test('a reply repeating the previous speaker drops the name', () => {
    const shown = [at(1, 'you'), at(2, 'you'), at(3, 'solus')]
    expect(shown.map((_, i) => showsAuthor(shown, i))).toEqual([true, false, true])
  })

  test('unread means Solus said something the reader has not seen', () => {
    // SAFETY: each assertion adds the timestamps that isUnread reads.
    const base = { id: 'c', selectedText: 's', comment: 'c', author: 'you' } as PlanComment
    // Your own thread with no answer is never unread — that would be unread of
    // yourself.
    expect(isUnread({ ...base, createdAt: 10, readAt: 10 })).toBe(false)
    expect(isUnread({ ...base, createdAt: 10, readAt: 10, replies: [at(20, 'you')] })).toBe(false)
    expect(isUnread({ ...base, createdAt: 10, readAt: 10, replies: [at(20, 'solus')] })).toBe(true)
    // Opening the thread clears it.
    expect(isUnread({ ...base, createdAt: 10, readAt: 30, replies: [at(20, 'solus')] })).toBe(false)
  })

  test('times stay relative for a week, then say when', () => {
    const now = Date.UTC(2026, 2, 20, 12, 0, 0)
    expect(threadTime(now - 30_000, now)).toBe('now')
    expect(threadTime(now - 2 * 60_000, now)).toBe('2m')
    expect(threadTime(now - 2 * 3_600_000, now)).toBe('2h')
    expect(threadTime(now - 30 * 3_600_000, now)).toBe('yesterday')
    expect(threadTime(now - 4 * 86_400_000, now)).toBe('4d')
    // Past a week "9d" stops being easier to read than the date.
    expect(threadTime(now - 9 * 86_400_000, now)).toMatch(/\d/)
    expect(threadTime(now - 9 * 86_400_000, now)).not.toMatch(/d$/)
  })
})
