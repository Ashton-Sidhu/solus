import { describe, expect, test } from 'bun:test'
import { uuid } from '@solus/contracts/uuid'
import type { Attachment } from '@solus/contracts/types'
import { attachmentUploads } from '../../packages/workspace-ui/src/components/input/lib/attachment-uploads.svelte'

function chip(): Attachment {
  return { id: uuid(), type: 'image', name: 'pasted image.png', path: 'pasted image.png', hostServerId: 'remote' }
}

/** A pasted image shows its chip before its upload ends; send must wait for it. */
describe('attachmentUploads.hold', () => {
  test('blocks send while the upload runs and releases it when it lands', async () => {
    const attachment = chip()
    let finish!: (value: string) => void
    const held = attachmentUploads.hold(attachment.id, 10, () => new Promise<string>((resolve) => { finish = resolve }))
    expect(attachmentUploads.stateFor(attachment.id)?.status).toBe('uploading')
    expect(attachmentUploads.sendBlocker([attachment])).toBe('Wait for the upload to finish.')
    finish('/host/pasted.png')
    expect(await held).toEqual({ status: 'done', attachment: '/host/pasted.png' })
    expect(attachmentUploads.sendBlocker([attachment])).toBeNull()
  })

  test('reports cancelled when the chip was removed during the upload', async () => {
    const attachment = chip()
    let finish!: (value: string) => void
    const held = attachmentUploads.hold(attachment.id, 10, () => new Promise<string>((resolve) => { finish = resolve }))
    attachmentUploads.cancel(attachment.id)
    finish('/host/pasted.png')
    expect(await held).toEqual({ status: 'cancelled' })
  })

  test('a failed upload rejects and does not leave the send blocked', async () => {
    const attachment = chip()
    await expect(attachmentUploads.hold(attachment.id, 10, async () => { throw new Error('offline') })).rejects.toThrow('offline')
    expect(attachmentUploads.sendBlocker([attachment])).toBeNull()
  })
})
