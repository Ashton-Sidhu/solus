import { describe, expect, test } from 'bun:test'
import {
  commentReplyTarget,
  quotedReplyBody,
  replyPreviewText,
} from '@solus/workspace-ui/components/pr-review/lib/comment-reply'

// A pull request conversation is flat on the host, so a reply must carry its
// own context: the quoted comment and the author's mention. Without them the
// posted comment reads as an unrelated remark on the host page.
describe('PR comment reply', () => {
  const target = commentReplyTarget({
    id: 'c1',
    kind: 'comment',
    author: 'octocat',
    body: 'Can we rename this?\n\nIt shadows `value`.',
    createdAt: '2026-01-01T10:00:00Z',
  })

  test('quotes every line of the target and mentions its author before the reply', () => {
    expect(quotedReplyBody(target, 'Done in the next push.')).toBe(
      '> Can we rename this?\n>\n> It shadows `value`.\n\n@octocat Done in the next push.',
    )
  })

  test('does not mention the author twice when the reply already names them', () => {
    expect(quotedReplyBody(target, 'Sure @octocat, renaming.')).toBe(
      '> Can we rename this?\n>\n> It shadows `value`.\n\nSure @octocat, renaming.',
    )
    // A longer login that starts with the same letters is not a mention of the author.
    expect(quotedReplyBody(target, '@octocat-bot did this').startsWith('> ')).toBe(true)
    expect(quotedReplyBody(target, '@octocat-bot did this')).toContain('@octocat @octocat-bot did this')
  })

  test('an empty target body posts the mention and reply alone', () => {
    expect(quotedReplyBody({ id: 'c2', author: 'a', body: '  ' }, 'ok')).toBe('@a ok')
  })

  test('the chip preview is the first line of prose, without quote or heading marks', () => {
    expect(replyPreviewText({ id: 'c3', author: 'a', body: '\n> ## Heading\n\nreal text' })).toBe('Heading')
    expect(replyPreviewText(target)).toBe('Can we rename this?')
    const long = { id: 'c4', author: 'a', body: 'x'.repeat(100) }
    expect(replyPreviewText(long, 20)).toHaveLength(20)
    expect(replyPreviewText(long, 20).endsWith('…')).toBe(true)
  })
})
