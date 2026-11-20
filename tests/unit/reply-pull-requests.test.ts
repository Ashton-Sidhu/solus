import { describe, expect, test } from 'bun:test'
import type { SessionPullRequestLink } from '@solus/contracts/session-pull-requests'
import { mentionsPullRequest, placeReplyPullRequests, type ReplySegment } from '@solus/client-core/reply-pull-requests'
import type { SessionArtifact } from '@solus/contracts/session-artifacts'
import type { Message } from '@solus/contracts/types'
import { turnReplyCards } from '../../packages/workspace-ui/src/components/conversation/lib/turn-reply-cards'
import type { Turn } from '../../packages/workspace-ui/src/components/conversation/lib/turns'

function link(number: number, repo = 'hunk'): SessionPullRequestLink {
  return {
    sessionId: 's',
    repository: `github.com/modem-dev/${repo}`,
    number,
    url: `https://github.com/modem-dev/${repo}/pull/${number}`,
    title: '',
    source: 'agent',
    linkedAt: 1,
  }
}

/** The segments as text, with each card as `[card #N]` and a group card as `[card #N #M]`. */
function shape(segments: ReplySegment[]): string[] {
  return segments.map((segment) =>
    segment.kind === 'text' ? segment.text : `[card ${segment.links.map((link) => `#${link.number}`).join(' ')}]`,
  )
}

describe('a mention of a pull request', () => {
  test('the URL, owner/repo#N, repo#N, and PR #N name it; a bare #N or another number does not', () => {
    const pr = link(12)
    expect(mentionsPullRequest('See https://github.com/modem-dev/hunk/pull/12.', pr)).toBe(true)
    expect(mentionsPullRequest('Opened modem-dev/hunk#12', pr)).toBe(true)
    expect(mentionsPullRequest('Opened hunk#12', pr)).toBe(true)
    expect(mentionsPullRequest('I opened PR #12 for this', pr)).toBe(true)
    expect(mentionsPullRequest('pull request #12', pr)).toBe(true)
    // WHY: #12 alone can be an issue, and #123 is another pull request.
    expect(mentionsPullRequest('Fixes #12', pr)).toBe(false)
    expect(mentionsPullRequest('https://github.com/modem-dev/hunk/pull/123', pr)).toBe(false)
    expect(mentionsPullRequest('PR #123', pr)).toBe(false)
    expect(mentionsPullRequest('other-hunk#12', pr)).toBe(false)
  })
})

describe('where a card goes in the final reply', () => {
  test('after the paragraph that mentions it, so the sentence stays whole', () => {
    // WHY: a card in the middle of a sentence breaks the reading flow.
    const reply = 'Done. I opened PR #12 with the fix.\n\nNext, run the tests.\n'
    expect(shape(placeReplyPullRequests(reply, [link(12)]).segments)).toEqual([
      'Done. I opened PR #12 with the fix.\n\n',
      '[card #12]',
      'Next, run the tests.\n',
    ])
  })

  test('a paragraph that is only the link becomes the card', () => {
    const reply = 'The pull request:\n\nhttps://github.com/modem-dev/hunk/pull/12\n\nThanks.'
    expect(shape(placeReplyPullRequests(reply, [link(12)]).segments)).toEqual(['The pull request:\n\n', '[card #12]', 'Thanks.'])
    const named = 'Here it is:\n\n[#12](https://github.com/modem-dev/hunk/pull/12)\n'
    expect(shape(placeReplyPullRequests(named, [link(12)]).segments)).toEqual(['Here it is:\n\n', '[card #12]'])
  })

  test('a link-only paragraph after the card goes, since the card already shows it', () => {
    // WHY: the reply named the pull request first, so the card sits there; the
    // bare link under it repeated the card.
    const reply = 'I linked PR #12.\n\nhttps://github.com/modem-dev/hunk/pull/12\n\nThanks.'
    expect(shape(placeReplyPullRequests(reply, [link(12)]).segments)).toEqual(['I linked PR #12.\n\n', '[card #12]', 'Thanks.'])
  })

  test('after the whole list, not between its items', () => {
    const reply = '- Opened PR #12\n\n- Updated the docs\n- Ran the tests\n\nAll done.'
    expect(shape(placeReplyPullRequests(reply, [link(12)]).segments)).toEqual([
      '- Opened PR #12\n\n- Updated the docs\n- Ran the tests\n\n',
      '[card #12]',
      'All done.',
    ])
  })

  test('a fenced block is never cut, and a mention only inside code puts the card at the end', () => {
    const reply = '```sh\n\ngh pr view 12 # PR #12\n\n```\n\nThat is all.'
    expect(shape(placeReplyPullRequests(reply, [link(12)]).segments)).toEqual(['```sh\n\ngh pr view 12 # PR #12\n\n```\n\nThat is all.', '[card #12]'])
  })

  test('only linked pull requests that the reply mentions are placed; the rest stay chips', () => {
    const placement = placeReplyPullRequests('Opened PR #12.', [link(12), link(13)])
    expect([...placement.placed]).toEqual(['github.com/modem-dev/hunk#12'])
    expect(shape(placement.segments)).toEqual(['Opened PR #12.', '[card #12]'])
    expect(placeReplyPullRequests('No pull requests here.', [link(12)])).toEqual({
      segments: [{ kind: 'text', text: 'No pull requests here.' }],
      placed: new Set(),
    })
  })

  test('a reply with reference links is not split: its cards follow it', () => {
    // WHY: splitting would cut [the fix][1] from its definition.
    const reply = 'See [the fix][1] in PR #12.\n\nMore.\n\n[1]: https://example.com'
    expect(shape(placeReplyPullRequests(reply, [link(12)]).segments)).toEqual([reply, '[card #12]'])
  })

  test('cards with no text between them share one group card; text between keeps them apart', () => {
    // WHY: a reply that reports several pull requests at once read as a stack
    // of cards; one card lists them. Pull requests named in separate
    // paragraphs keep a card each, under the words about them.
    const together = 'I opened PR #12 and PR #13.\n\nRun the tests.'
    expect(shape(placeReplyPullRequests(together, [link(12), link(13)]).segments)).toEqual([
      'I opened PR #12 and PR #13.\n\n',
      '[card #12 #13]',
      'Run the tests.',
    ])
    const links = 'The fixes:\n\nhttps://github.com/modem-dev/hunk/pull/12\n\nhttps://github.com/modem-dev/hunk/pull/13\n'
    expect(shape(placeReplyPullRequests(links, [link(12), link(13)]).segments)).toEqual(['The fixes:\n\n', '[card #12 #13]'])
    const apart = 'PR #12 fixes the build.\n\nPR #13 fixes the docs.'
    expect(shape(placeReplyPullRequests(apart, [link(12), link(13)]).segments)).toEqual([
      'PR #12 fixes the build.\n\n',
      '[card #12]',
      'PR #13 fixes the docs.',
      '[card #13]',
    ])
  })

  test('the text parts join back to the exact reply', () => {
    const reply = 'A\n\n- PR #12\n  more\n\n```\nx\n```\nhunk#13 too\n\n\nend'
    const text = placeReplyPullRequests(reply, [link(12), link(13)]).segments
      .flatMap((segment) => (segment.kind === 'text' ? [segment.text] : [])).join('')
    expect(text).toBe(reply)
  })
})

describe('the final reply of a turn', () => {
  const pr: SessionArtifact = { kind: 'pull-request', link: { ...link(12), linkedAt: 150 } }
  const message = (id: string, content: string) => ({ id, role: 'assistant', content, timestamp: 0 }) as Message
  const turn = (extra: Partial<Turn> = {}): Turn => ({
    id: 't', lead: null, body: [], visibleWhenCollapsed: [], images: [], tools: [], live: false, end: null, startedAt: 100,
    tail: [{ kind: 'assistant', message: message('early', 'Opened PR #12.') }, { kind: 'assistant', message: message('last', 'Done: PR #12 is open.') }],
    ...extra,
  })

  test('cards go in the last reply of a finished turn, for pull requests that turn linked', () => {
    // WHY: the card belongs where the agent reports the result, not in an
    // earlier progress note, and never in a turn that is still running.
    const cards = turnReplyCards(turn(), [pr], null)
    expect(cards?.replyId).toBe('last')
    expect([...(cards?.placed ?? [])]).toEqual(['github.com/modem-dev/hunk#12'])
    expect(turnReplyCards(turn({ live: true }), [pr], null)).toBeNull()
    // Linked during the next turn: this turn's reply gets no card for it.
    expect(turnReplyCards(turn(), [pr], 120)).toBeNull()
  })
})
