import { afterAll, describe, expect, it } from 'bun:test'
import type { OutboundPrompt } from '@solus/contracts/types'
import type { QueueAttachment } from '@solus/contracts/session-queue'
import type { SessionQueueController } from '@solus/workspace-ui/contexts/workspace/session-queue.store.svelte'
import type { QueueEdit as QueueEditType } from '@solus/workspace-ui/components/conversation/queued/lib/queue-edit.svelte'
import { SvelteRunes } from './helpers/svelte-runes'

const runes = new SvelteRunes()
afterAll(() => runes.dispose())
const { QueueEdit } = (await import(runes.source(
  'queue-edit',
  'packages/workspace-ui/src/components/conversation/queued/lib/queue-edit.svelte.ts',
  { '../../../input/lib/attachment-upload': SvelteRunes.file('packages/workspace-ui/src/components/input/lib/attachment-upload.ts') },
))) as { QueueEdit: typeof QueueEditType }

// The queued prompt editor must take a pasted screenshot as an attachment, as
// the composer does, and must leave a text paste to the field.
function editWith(uploaded: File[][]): QueueEditType {
  const queue = {
    upload: async (_tabId: string, files: File[]): Promise<QueueAttachment[]> => {
      uploaded.push(files)
      return files.map((file, index) => ({ id: `a${index}`, type: 'image', name: file.name, mimeType: file.type, size: file.size }))
    },
  } as Pick<SessionQueueController, 'upload'> as SessionQueueController
  const source = { text: 'Queued', queueAttachments: [] } as Pick<OutboundPrompt, 'text' | 'queueAttachments'> as OutboundPrompt
  return new QueueEdit(queue, 'tab-1', source, { provider: 'claude', modelConfig: { modelId: null, contextWindow: null } } as never, () => null)
}

describe('QueueEdit.paste', () => {
  it('attaches a pasted screenshot', async () => {
    const uploaded: File[][] = []
    const edit = editWith(uploaded)
    const screenshot = new File(['png'], 'image.png', { type: 'image/png' })
    expect(edit.paste({ items: [{ type: 'image/png', getAsFile: () => screenshot }], files: [screenshot] })).toBe(true)
    await Bun.sleep(0)
    expect(uploaded).toEqual([[screenshot]])
    expect(edit.attachments?.map((item) => item.name)).toEqual(['image.png'])
    expect(edit.changed).toBe(true)
  })

  it('leaves a text paste to the field', () => {
    const uploaded: File[][] = []
    const edit = editWith(uploaded)
    expect(edit.paste({ items: [{ type: 'text/plain', getAsFile: () => null }], files: [] })).toBe(false)
    expect(uploaded).toEqual([])
  })
})
