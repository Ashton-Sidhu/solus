import { expect, test } from 'bun:test'
import type { GoogleCommentOperation } from '@solus/contracts/work-comments'
import type { DocCommentThread } from '@solus/contracts/work-comments'
import { formatExternalThreadsForAgent, outboundText, publishState, shareOperation } from '../../packages/workspace-ui/src/components/work/lib/external-comments-view'

function sent(sourceMessageId: string, text: string, quote?: string): GoogleCommentOperation {
  return { requestId: `req-${sourceMessageId}`, status: 'sent', command: { kind: 'share', requestId: `req-${sourceMessageId}`, sourceMessageId, text, quote } }
}
function receipt(status: GoogleCommentOperation['status'], error?: string): GoogleCommentOperation {
  return { requestId: 'req', status, error, command: { kind: 'share', requestId: 'req', sourceMessageId: 'note', text: 'Publish me' } }
}

test('a shared receipt belongs to one message, so an identical sibling still reads as local', () => {
  const operations = [sent('first', 'Looks good', 'the quote')]
  expect(shareOperation(operations, 'first', 'Looks good', 'the quote')?.status).toBe('sent')
  // Same words, different message: this one has never left Solus.
  expect(shareOperation(operations, 'second', 'Looks good', 'the quote')).toBeUndefined()
  // Same message, edited since it was shared: the sent state does not carry over.
  expect(shareOperation(operations, 'first', 'Looks good now', 'the quote')).toBeUndefined()
  expect(shareOperation(undefined, 'first', 'Looks good', 'the quote')).toBeUndefined()
})

test('a retry matches its own receipt through the trimming the card applies before sending', () => {
  const operations = [sent('note', 'Solus: needs a source', 'quote')]
  expect(shareOperation(operations, 'note', outboundText('needs a source  ', 'solus'), ' quote ')?.status).toBe('sent')
})

test('an agent message names itself, because Google credits the connected account', () => {
  expect(outboundText('needs a source', 'solus')).toBe('Solus: needs a source')
  expect(outboundText(' needs a source ', 'you')).toBe('needs a source')
  expect(outboundText('needs a source')).toBe('needs a source')
})

test('publishing is offered once: a sent or unconfirmed message can never be pressed again', () => {
  // Nothing published can be recalled, so only a definite rejection reopens the
  // button. Every other blocked state still has to say why in its own label.
  expect(publishState(receipt('sent'), false, 'Publish me')).toMatchObject({ kind: 'published', canPublish: false })
  expect(publishState(receipt('uncertain'), false, 'Publish me').canPublish).toBe(false)
  expect(publishState(receipt('uncertain'), false, 'Publish me').label).toMatch(/not confirmed/i)
  expect(publishState(receipt('sending'), false, 'Publish me').canPublish).toBe(false)
  expect(publishState(undefined, true, 'Publish me').canPublish).toBe(false)

  const failed = publishState(receipt('failed', 'Google rejected the request.'), false, 'Publish me')
  expect(failed).toMatchObject({ kind: 'failed', canPublish: true })
  expect(failed.label).toContain('Google rejected the request.')
})

test('every state carries its own explanation, because the tooltip is the only place to put one', () => {
  const states = [
    publishState(undefined, false, 'Publish me'),
    publishState(undefined, false, ''),
    publishState(receipt('sent'), false, 'Publish me'),
    publishState(receipt('sending'), false, 'Publish me'),
    publishState(receipt('uncertain'), false, 'Publish me'),
    publishState(receipt('failed'), false, 'Publish me'),
  ]
  for (const state of states) expect(state.label.length).toBeGreaterThan(0)
  expect(publishState(undefined, false, '').canPublish).toBe(false)
  expect(publishState(undefined, false, 'Publish me')).toMatchObject({ kind: 'ready', canPublish: true })
})

function thread(overrides: Partial<DocCommentThread>): DocCommentThread {
  return {
    id: 'AAAA',
    text: 'Change the launch date to Monday.',
    quote: 'The launch date is Friday.',
    author: { name: 'Reviewer', isMe: false },
    createdAt: '2026-09-09T00:00:00Z',
    modifiedAt: '2026-09-09T00:00:00Z',
    resolved: false,
    deleted: false,
    replies: [],
    ...overrides,
  }
}

test('the rail hands provider threads to the agent as review content it may not answer upstream', () => {
  const text = formatExternalThreadsForAgent(
    [thread({ replies: [{ id: 'r1', text: 'Agreed.', author: { name: 'Ashton', isMe: true }, createdAt: '', modifiedAt: '', deleted: false }] })],
    'gdrive',
  )
  expect(text).toContain('Google Docs thread AAAA on "The launch date is Friday."')
  expect(text).toContain('Reviewer: Change the launch date to Monday.')
  expect(text).toContain('Ashton: Agreed.')
  // The guard is the point: a reviewer's words are not an instruction to post back.
  expect(text).toContain('Do not post to Google Docs')
})

test('a settled provider thread is not re-sent, and a work with none adds nothing to the prompt', () => {
  expect(formatExternalThreadsForAgent([thread({ resolved: true })], 'gdrive')).toBe('')
  expect(formatExternalThreadsForAgent([thread({ deleted: true })], 'confluence')).toBe('')
  expect(formatExternalThreadsForAgent([], 'gdrive')).toBe('')
  // A deleted reply is a tombstone in the provider; it is not part of the conversation.
  const text = formatExternalThreadsForAgent(
    [thread({ replies: [{ id: 'r1', text: 'Ignore me', author: { name: 'Reviewer', isMe: false }, createdAt: '', modifiedAt: '', deleted: true }] })],
    'confluence',
  )
  expect(text).toContain('Confluence thread AAAA')
  expect(text).not.toContain('Ignore me')
})
