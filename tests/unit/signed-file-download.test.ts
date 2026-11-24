import { expect, spyOn, test } from 'bun:test'
import { MAX_ATTACHMENT_UPLOAD_BYTES } from '@solus/contracts/rpc'
import { downloadSignedFile } from '@solus/workspace-ui/lib/signed-file-download'

const signedPath = '/api/assets/file.signature'
const origin = 'https://box.example'

test('downloads reject oversized bodies with or without a declared length', async () => {
  const cancelDeclared = spyOn(ReadableStream.prototype, 'cancel')
  const fetchFile = spyOn(globalThis, 'fetch').mockImplementation(async () =>
    new Response('only a few bytes', { headers: { 'Content-Length': String(MAX_ATTACHMENT_UPLOAD_BYTES + 1) } }))
  try {
    await expect(downloadSignedFile(signedPath, origin, new AbortController().signal)).rejects.toThrow('10 MiB')
    expect(cancelDeclared).toHaveBeenCalled()
    let didCancelStream = false
    fetchFile.mockImplementation(async () => new Response(new ReadableStream({
      start(controller) { controller.enqueue(new Uint8Array(MAX_ATTACHMENT_UPLOAD_BYTES + 1)) },
      cancel() { didCancelStream = true },
    })))
    await expect(downloadSignedFile(signedPath, origin, new AbortController().signal)).rejects.toThrow('10 MiB')
    expect(didCancelStream).toBe(true)
  } finally {
    fetchFile.mockRestore()
    cancelDeclared.mockRestore()
  }
})

test('unsigned URLs, missing permission, and partial files are refused', async () => {
  const fetchFile = spyOn(globalThis, 'fetch').mockImplementation(async () => new Response('Denied', { status: 403 }))
  try {
    await expect(downloadSignedFile('/api/assets/file.signature?redirect=true', origin, new AbortController().signal))
      .rejects.toThrow('invalid file download URL')
    expect(fetchFile).not.toHaveBeenCalled()
    await expect(downloadSignedFile(signedPath, origin, new AbortController().signal)).rejects.toThrow('could not send')
    fetchFile.mockImplementation(async () => new Response('part of the file', { status: 206 }))
    await expect(downloadSignedFile(signedPath, origin, new AbortController().signal)).rejects.toThrow('could not send')
  } finally {
    fetchFile.mockRestore()
  }
})
