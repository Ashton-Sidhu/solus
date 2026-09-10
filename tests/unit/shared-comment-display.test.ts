import { expect, test } from 'bun:test'
import type { PlanComment } from '@solus/contracts/types'
import type { WorkExternalComments } from '@solus/contracts/work-comments'
import { externalCommentBody, localCommentsForDisplay } from '@solus/workspace-ui/components/work/lib/external-comments-view'

function fixture(): { local: PlanComment; snapshot: WorkExternalComments } {
  return {
    local: { id: 'local', comment: 'ooga', selectedText: 'Selected sentence' },
    snapshot: {
      provider: 'gdrive', externalKey: 'root', documentId: 'doc',
      threads: [{ id: 'remote', text: 'Quoted text:\nSelected sentence\n\nooga', quote: 'Selected sentence', author: { name: 'You', isMe: true }, createdAt: '', modifiedAt: '', deleted: false, resolved: false, replies: [] }],
      operations: [{ requestId: 'request', status: 'sent', command: { kind: 'share', requestId: 'request', sourceMessageId: 'local', text: 'ooga', quote: 'Selected sentence' }, result: { threadId: 'remote' } }],
    },
  }
}

test('an acknowledged share renders once without deleting its local record', () => {
  const { local, snapshot } = fixture()
  const originals = [local]
  expect(localCommentsForDisplay(originals, snapshot)).toEqual([])
  expect(originals).toEqual([local])
  snapshot.threads[0].resolved = true
  expect(localCommentsForDisplay(originals, snapshot)).toEqual([])
  snapshot.threads[0].deleted = true
  expect(localCommentsForDisplay(originals, snapshot)).toEqual([local])
})

test('missing or uncertain acknowledgement never hides a local comment', () => {
  for (const status of ['failed', 'sending', 'uncertain'] as const) {
    const { local, snapshot } = fixture()
    snapshot.operations[0].status = status
    expect(localCommentsForDisplay([local], snapshot)).toEqual([local])
  }
  const { local, snapshot } = fixture()
  delete snapshot.operations[0].result
  expect(localCommentsForDisplay([local], snapshot)).toEqual([local])
})

test('private replies, changed drafts and identical unrelated messages stay visible', () => {
  const { local, snapshot } = fixture()
  const privateReply = { ...local, replies: [{ id: 'private', author: 'solus' as const, text: 'Private note', createdAt: 1 }] }
  const edited = { ...local, comment: 'New draft' }
  const other = { ...local, id: 'unrelated' }
  expect(localCommentsForDisplay([privateReply, edited, other], snapshot)).toEqual([privateReply, edited, other])
  expect(localCommentsForDisplay([local])).toEqual([local])
  snapshot.operations[0].command.target = { provider: 'gdrive', documentId: 'other-doc', externalKey: 'root' }
  expect(localCommentsForDisplay([local], snapshot)).toEqual([local])
})

test('old quote preamble is shown once, while ordinary message text is preserved', () => {
  const { snapshot } = fixture()
  const thread = snapshot.threads[0]
  expect(externalCommentBody(thread)).toBe('ooga')
  expect(thread.text).toBe('Quoted text:\nSelected sentence\n\nooga')
  expect(externalCommentBody({ ...thread, quote: '' })).toBe(thread.text)
  expect(externalCommentBody({ ...thread, text: 'Different body' })).toBe('Different body')
})
