import { expect, test } from 'bun:test'
import type { SessionQueueMutation } from '@solus/contracts/session-queue'
import { QueueDraft } from '../../apps/mobile/src/features/conversation/lib/queue-edit'

test('queue edits retain files until Save, preserve source revisions, and leave a conflicting draft intact', async () => {
  const changes: SessionQueueMutation[] = []
  const original = { queueId: 'q', text: 'Before', enqueuedAt: 1, reason: 'busy' as const, revision: 2,
    attachments: [{ id: 'f', type: 'file' as const, name: 'notes.md', hostPath: '/host/notes.md' }] }
  const draft = new QueueDraft(original, {
    changeQueue: async (mutation) => { changes.push(mutation); throw new Error('This queue entry changed.') },
    uploadQueueFiles: async () => [{ id: 'new', type: 'file', name: 'new.md', hostPath: '/host/new.md' }],
  })
  draft.text = 'After'
  await draft.addFiles([{ uri: '/phone/new.md', name: 'new.md', mimeType: 'text/plain', size: 10 }])
  expect(changes).toHaveLength(0)
  expect(original.attachments).toHaveLength(1)
  await expect(draft.save()).rejects.toThrow('changed')
  expect(draft.text).toBe('After')
  expect(changes[0]).toMatchObject({ kind: 'edit', revision: 2, attachments: [original.attachments[0], { name: 'new.md' }] })
  expect(changes[0]).toHaveProperty('attachmentContext', '[Attached file: /host/notes.md]\n[Attached file: /host/new.md]')
})

test('text-only queue edits keep rich file context on the host', async () => {
  const changes: SessionQueueMutation[] = []
  const draft = new QueueDraft({ queueId: 'q', text: 'Before', enqueuedAt: 1, reason: 'busy', revision: 1,
    attachments: [{ id: 'f', type: 'design-selection', name: 'Selection', hostPath: '/capture.png', context: 'Full design annotation' }] }, {
    changeQueue: async (mutation) => { changes.push(mutation) }, uploadQueueFiles: async () => [],
  })
  draft.text = 'After'
  await draft.save()
  expect(changes[0]).toMatchObject({ attachments: undefined, attachmentContext: undefined, text: 'After' })
})
