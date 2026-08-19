import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, readFile, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { isAbsolute, join, relative } from 'path'
import { writeAttachmentUpload } from '@solus/server/server/handlers/attachment-handlers'
import {
  MAX_ATTACHMENT_UPLOAD_BYTES,
  MAX_ATTACHMENT_UPLOAD_COUNT,
} from '@solus/contracts/rpc'
import type { IpcContext } from '@solus/contracts/types'

function context(sessionId: string): IpcContext {
  return { session: { sessionId } } as IpcContext
}

function dataUrl(contents: Buffer, mime = 'text/plain'): string {
  return `data:${mime};base64,${contents.toString('base64')}`
}

describe('attachment upload handler', () => {
  let root = ''

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'solus-attachment-upload-'))
  })

  afterEach(async () => {
    if (root) await rm(root, { recursive: true, force: true })
  })

  test('writes below the host attachment area in a per-session folder', async () => {
    const contents = Buffer.from('host-owned bytes')
    const path = await writeAttachmentUpload(
      context('session/with unsafe path'),
      { name: '../notes.txt', mime: 'text/plain', dataUrl: dataUrl(contents) },
      { attachmentsDir: root },
    )

    expect(isAbsolute(path)).toBe(true)
    expect(relative(root, path).startsWith('..')).toBe(false)
    expect(relative(root, path).split('/')).toHaveLength(2)
    expect(path.endsWith('-notes.txt')).toBe(true)
    expect(await readFile(path)).toEqual(contents)
  })

  test('refuses a file above the shared byte cap', async () => {
    const oversized = Buffer.alloc(MAX_ATTACHMENT_UPLOAD_BYTES + 1)
    await expect(writeAttachmentUpload(
      context('oversized'),
      { name: 'large.bin', mime: 'application/octet-stream', dataUrl: dataUrl(oversized, 'application/octet-stream') },
      { attachmentsDir: root },
    )).rejects.toThrow('10 MB')
  })

  test('enforces the shared per-session count cap', async () => {
    const ctx = context('counted-session')
    for (let index = 0; index < MAX_ATTACHMENT_UPLOAD_COUNT; index++) {
      await writeAttachmentUpload(
        ctx,
        { name: `${index}.txt`, mime: 'text/plain', dataUrl: dataUrl(Buffer.from(String(index))) },
        { attachmentsDir: root },
      )
    }

    await expect(writeAttachmentUpload(
      ctx,
      { name: 'extra.txt', mime: 'text/plain', dataUrl: dataUrl(Buffer.from('extra')) },
      { attachmentsDir: root },
    )).rejects.toThrow(`at most ${MAX_ATTACHMENT_UPLOAD_COUNT}`)
  })

  test('keeps the count cap under concurrent uploads', async () => {
    const ctx = context('concurrent-session')
    const results = await Promise.allSettled(
      Array.from({ length: MAX_ATTACHMENT_UPLOAD_COUNT + 1 }, (_, index) =>
        writeAttachmentUpload(
          ctx,
          { name: `${index}.txt`, mime: 'text/plain', dataUrl: dataUrl(Buffer.from(String(index))) },
          { attachmentsDir: root },
        )),
    )

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(MAX_ATTACHMENT_UPLOAD_COUNT)
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1)
  })
})
