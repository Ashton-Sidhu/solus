import { expect, test } from 'bun:test'
import type { Message } from '@solus/contracts/types'
import { artifactRevisionIndex, createArtifactRevisionIndexer, fenceArtifactIdentity } from '@solus/workspace-ui/components/conversation/lib/artifact-revisions'

function reply(id: string, content: string): Message {
  return { id, role: 'assistant', content, timestamp: 1 }
}

function fence(identity: string, body: string, closed = true): string {
  return `\`\`\`html render artifact=${identity}\n${body}\n${closed ? '\`\`\`' : ''}`
}

test('explicit fence identity connects revisions without merging separate visuals', () => {
  const messages = [reply('first', fence('chart', '<p>One</p>')), reply('other', fence('alternative', '<p>One</p>')), reply('last', fence('chart', '<p>Two</p>'))]
  const revisions = artifactRevisionIndex(messages)
  expect(revisions.get('fence:chart')?.map((entry) => entry.messageId)).toEqual(['first', 'last'])
  expect(revisions.get('fence:alternative')).toHaveLength(1)
  expect(revisions.get('fence:chart')?.[0].html).toBe('<p>One</p>')
})

test('an incomplete or source fence cannot collapse the last completed render', () => {
  const streaming = reply('next', fence('chart', '<p>Two</p>', false))
  const messages = [reply('first', fence('chart', '<p>One</p>')), streaming]
  expect(artifactRevisionIndex(messages).get('fence:chart')).toHaveLength(1)
  streaming.content += '\`\`\`'
  expect(artifactRevisionIndex(messages).get('fence:chart')).toHaveLength(2)
  streaming.content = streaming.content.replace('html render', 'html source')
  expect(artifactRevisionIndex(messages).get('fence:chart')).toHaveLength(1)
})

test('saved revisions use work IDs and exclude provisional renders and images', () => {
  const first: Message = { ...reply('first', ''), artifact: { kind: 'html', html: 'one' }, workRef: { workId: 'a', title: 'Chart' } }
  const other: Message = { ...reply('other', ''), artifact: { kind: 'html', html: 'other' }, workRef: { workId: 'b', title: 'Chart' } }
  const next: Message = { ...reply('next', ''), artifact: { kind: 'html', html: 'two', streaming: true }, workRef: { workId: 'a', title: 'Renamed' } }
  const messages = [first, other, next, { ...reply('image', ''), artifact: { kind: 'image' as const, path: '/image.png' } }]
  expect(artifactRevisionIndex(messages).get('work:a')).toHaveLength(1)
  next.artifact!.streaming = false
  const index = artifactRevisionIndex(messages)
  expect(index.get('work:a')?.map((entry) => entry.title)).toEqual(['Chart', 'Renamed'])
  expect(index.get('work:b')).toHaveLength(1)
  expect(index.size).toBe(2)
})

test('identity is case-sensitive, bounded and must occupy a whole info word', () => {
  expect(fenceArtifactIdentity('html render artifact=Chart_2')).toBe('Chart_2')
  expect(fenceArtifactIdentity('html render artifact=bad/value')).toBeUndefined()
  expect(fenceArtifactIdentity(`html artifact=${'a'.repeat(81)}`)).toBeUndefined()
  expect(fenceArtifactIdentity('html render')).toBeUndefined()
})

test('prose streaming preserves the artifact index and unchanged revision objects', () => {
  const index = createArtifactRevisionIndexer()
  const messages = [reply('first', fence('chart', '<p>One</p>')), reply('text', 'Writing')]
  const original = index(messages)
  messages[1].content += ' more text'
  expect(index(messages)).toBe(original)
  messages.push(reply('second', fence('another', '<p>Other</p>')))
  const next = index(messages)
  expect(next).not.toBe(original)
  expect(next.get('fence:chart')).toBe(original.get('fence:chart'))
})
