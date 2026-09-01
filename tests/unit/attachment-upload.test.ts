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
import {
  clipboardImages,
  type ClipboardImageItem,
} from '@solus/workspace-ui/components/input/lib/attachment-upload'

function context(sessionId: string): IpcContext {
  return { session: { sessionId } } as IpcContext
}

/** What a composer that has not started a session yet sends. */
function draftContext(draftId: string): IpcContext {
  return { session: { sessionId: '', draftId } } as IpcContext
}

function dataUrl(contents: Buffer, mime = 'text/plain'): string {
  return `data:${mime};base64,${contents.toString('base64')}`
}

describe('clipboard images', () => {
  function clipboardItems(types: string[]): ClipboardImageItem[] {
    return types.map((type) => ({
      type,
      getAsFile: () => (type.startsWith('image/') ? new File([type], `${type}.bin`, { type }) : null),
    }))
  }

  test('takes every image on the clipboard, not just the first', () => {
    const blobs = clipboardImages({ items: clipboardItems(['image/png', 'image/jpeg']) })

    expect(blobs.map((blob) => blob.type)).toEqual(['image/png', 'image/jpeg'])
  })

  test('ignores clipboard entries that are not images', () => {
    const blobs = clipboardImages({ items: clipboardItems(['text/plain', 'image/png', 'text/html']) })

    expect(blobs.map((blob) => blob.type)).toEqual(['image/png'])
  })

  // iOS Safari reports a pasted screenshot or photo in `files` alone, so a
  // phone paste attaches nothing when only `items` is read.
  test('takes an image that only reaches the clipboard as a file', () => {
    const photo = new File(['photo'], 'IMG_0001.png', { type: 'image/png' })

    const blobs = clipboardImages({ items: [], files: [photo] })

    expect(blobs.map((blob) => blob.name)).toEqual(['IMG_0001.png'])
  })

  test('attaches an image reported in both lists only once', () => {
    const shot = new File(['image/png'], 'image/png.bin', { type: 'image/png' })

    const blobs = clipboardImages({ items: clipboardItems(['image/png']), files: [shot] })

    expect(blobs).toHaveLength(1)
  })
})

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

  // Uploading is per conversation, and a draft is a conversation the user has
  // begun. Requiring a *started* session made every first paste on a phone fail,
  // because a phone almost always composes from a draft.
  test('accepts an upload from a draft that has not started a session', async () => {
    const contents = Buffer.from('composed before sending')
    const path = await writeAttachmentUpload(
      draftContext('draft-abc'),
      { name: 'pasted image.png', mime: 'text/plain', dataUrl: dataUrl(contents) },
      { attachmentsDir: root },
    )

    expect(relative(root, path).split('/')).toHaveLength(2)
    expect(await readFile(path)).toEqual(contents)
  })

  // Each conversation gets its own folder — that separation is what stops one
  // from reading another's uploads or spending another's slot cap. A draft is
  // not exempt from it just because it has no session id.
  test('files each draft in its own folder', async () => {
    const write = (ctx: IpcContext) => writeAttachmentUpload(
      ctx,
      { name: 'shot.png', mime: 'text/plain', dataUrl: dataUrl(Buffer.from('x')) },
      { attachmentsDir: root },
    )
    const folderOf = (path: string) => relative(root, path).split('/')[0]

    const draft = await write(draftContext('draft-one'))
    const otherDraft = await write(draftContext('draft-two'))
    const startedSession = await write(context('session-one'))

    expect(new Set([draft, otherDraft, startedSession].map(folderOf)).size).toBe(3)
  })

  test('a draft spends its own slot cap, not a started session\'s', async () => {
    const ctx = draftContext('capped-draft')
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

  test('refuses an upload with neither a session nor a draft behind it', async () => {
    await expect(writeAttachmentUpload(
      context(''),
      { name: 'orphan.txt', mime: 'text/plain', dataUrl: dataUrl(Buffer.from('x')) },
      { attachmentsDir: root },
    )).rejects.toThrow('A conversation is required')
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
