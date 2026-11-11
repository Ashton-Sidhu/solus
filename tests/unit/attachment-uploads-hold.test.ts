import { describe, expect, test } from 'bun:test'
import { uuid } from '@solus/contracts/uuid'
import type { Attachment } from '@solus/contracts/types'
import { attachmentUploads } from '../../packages/workspace-ui/src/components/input/lib/attachment-uploads.svelte'

function chip(): Attachment {
  return { id: uuid(), type: 'image', name: 'pasted image.png', path: 'pasted image.png', hostServerId: 'remote' }
}

/** A pasted image shows its chip before its upload ends. A prompt sent
 *  meanwhile takes the chip and waits for the host's copy from `landed`. */
describe('attachmentUploads.hold', () => {
  test('a send waits for the upload and gets the host copy when it lands', async () => {
    const attachment = chip()
    let finish!: (value: Attachment) => void
    const held = attachmentUploads.hold(attachment.id, 10, () => new Promise<Attachment>((resolve) => { finish = resolve }))
    expect(attachmentUploads.stateFor(attachment.id)?.status).toBe('uploading')
    expect(attachmentUploads.isUploading([attachment])).toBe(true)
    // In flight is not a reason to refuse Send.
    expect(attachmentUploads.sendBlocker([attachment])).toBeNull()
    const landed = attachmentUploads.landed(attachment)
    finish({ ...attachment, id: 'from-host', hostPath: '/host/pasted.png' })
    expect(await held).toMatchObject({ status: 'done', attachment: { hostPath: '/host/pasted.png' } })
    // The waiter gets the host copy under the chip's own id.
    expect(await landed).toEqual({ status: 'landed', attachment: { ...attachment, hostPath: '/host/pasted.png' } })
    expect(attachmentUploads.isUploading([attachment])).toBe(false)
  })

  test('reports cancelled when the chip was removed during the upload', async () => {
    const attachment = chip()
    let finish!: (value: Attachment) => void
    const held = attachmentUploads.hold(attachment.id, 10, () => new Promise<Attachment>((resolve) => { finish = resolve }))
    const landed = attachmentUploads.landed(attachment)
    attachmentUploads.cancel(attachment.id)
    finish({ ...attachment, hostPath: '/host/pasted.png' })
    expect(await held).toEqual({ status: 'cancelled' })
    expect((await landed).status).toBe('failed')
  })

  test('a failed upload rejects, tells a waiting send why, and does not leave Send blocked', async () => {
    const attachment = chip()
    let fail!: (error: Error) => void
    const held = attachmentUploads.hold(attachment.id, 10, () => new Promise<Attachment>((_resolve, reject) => { fail = reject }))
    const landed = attachmentUploads.landed(attachment)
    fail(new Error('offline'))
    await expect(held).rejects.toThrow('offline')
    expect(await landed).toEqual({ status: 'failed', message: 'offline' })
    expect(attachmentUploads.sendBlocker([attachment])).toBeNull()
  })
})
