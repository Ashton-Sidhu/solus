import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { randomBytes } from 'crypto'
import { existsSync } from 'fs'
import { mkdtemp, readFile, readdir, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { dirname, isAbsolute, join, relative } from 'path'
import {
  ATTACHMENT_UPLOAD_TOKEN_TTL_MS,
  createAttachmentUploadToken,
  receiveAttachmentUpload,
  writeAttachmentUpload,
} from '@solus/server/server/handlers/attachment-handlers'
import { serveAssetToken } from '@solus/server/server/assets'
import { signToken } from '@solus/server/server/signed-token'
import { MAX_VIDEO_UPLOAD_BYTES } from '@solus/contracts/video'
import {
  MAX_ATTACHMENT_UPLOAD_BYTES,
  MAX_ATTACHMENT_UPLOAD_COUNT,
} from '@solus/contracts/rpc'
import type { IpcContext } from '@solus/contracts/types'
import {
  attachmentKind,
  attachmentUploadRoute,
  clipboardMedia,
  postAttachmentBytes,
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
    const blobs = clipboardMedia({ items: clipboardItems(['image/png', 'image/jpeg']) })

    expect(blobs.map((blob) => blob.type)).toEqual(['image/png', 'image/jpeg'])
  })

  test('ignores clipboard entries that are not images', () => {
    const blobs = clipboardMedia({ items: clipboardItems(['text/plain', 'image/png', 'text/html']) })

    expect(blobs.map((blob) => blob.type)).toEqual(['image/png'])
  })

  // iOS Safari reports a pasted screenshot or photo in `files` alone, so a
  // phone paste attaches nothing when only `items` is read.
  test('takes an image that only reaches the clipboard as a file', () => {
    const photo = new File(['photo'], 'IMG_0001.png', { type: 'image/png' })

    const blobs = clipboardMedia({ items: [], files: [photo] })

    expect(blobs.map((blob) => blob.name)).toEqual(['IMG_0001.png'])
  })

  test('attaches an image reported in both lists only once', () => {
    const shot = new File(['image/png'], 'image/png.bin', { type: 'image/png' })

    const blobs = clipboardMedia({ items: clipboardItems(['image/png']), files: [shot] })

    expect(blobs).toHaveLength(1)
  })
})

describe('attachment upload route', () => {
  const streaming = { attachStreamUpload: true }
  const olderHost = {}
  const MB = 1024 * 1024

  test('a video is a file with its video type, never an image', () => {
    // WHY: a video marked as an image would be sent as image content, which
    // neither provider can read, and the bubble would draw it as a picture.
    expect(attachmentKind({ name: 'bug.mov', mimeType: '' })).toEqual({ type: 'file', mimeType: 'video/quicktime', isVideo: true })
    expect(attachmentKind({ name: 'shot.png', mimeType: 'image/png' })).toEqual({ type: 'image', mimeType: 'image/png', isVideo: false })
    expect(attachmentKind({ name: 'notes', mimeType: '' })).toEqual({ type: 'file', mimeType: 'application/octet-stream', isVideo: false })
  })

  test('every video streams when the host can take a stream, however small', () => {
    // WHY: base64 in one WebSocket frame is what a phone cannot afford for video.
    expect(attachmentUploadRoute({ name: 'bug.mp4', mimeType: 'video/mp4', size: 1 * MB }, streaming)).toBe('stream')
    expect(attachmentUploadRoute({ name: 'bug.webm', mimeType: '', size: 40 * MB }, streaming)).toBe('stream')
  })

  test('only videos may exceed 10 MB; other files keep the RPC and its limit', () => {
    // WHY: the host refuses a streamed non-video over 10 MB, so the client must
    // say so before it spends the user's bandwidth on a doomed upload.
    expect(() => attachmentUploadRoute({ name: 'dump.log', mimeType: 'text/plain', size: 11 * MB }, streaming))
      .toThrow('Files other than videos can be up to 10 MB.')
    expect(attachmentUploadRoute({ name: 'spec.pdf', mimeType: 'application/pdf', size: 2 * MB }, streaming)).toBe('rpc')
  })

  test('a video over the video limit is refused before any upload starts', () => {
    expect(() => attachmentUploadRoute({ name: 'long.mp4', mimeType: 'video/mp4', size: MAX_VIDEO_UPLOAD_BYTES + 1 }, streaming))
      .toThrow('Videos can be up to 50 MB.')
  })

  test('an older host keeps the RPC path and says to update it for large files', () => {
    // WHY: a host without the stream route must still take what it always took.
    expect(attachmentUploadRoute({ name: 'bug.mp4', mimeType: 'video/mp4', size: 3 * MB }, olderHost)).toBe('rpc')
    expect(() => attachmentUploadRoute({ name: 'bug.mp4', mimeType: 'video/mp4', size: 20 * MB }, olderHost))
      .toThrow('Update the host')
  })
})

describe('clipboard videos', () => {
  test('takes a pasted video file but not other files', () => {
    const video = new File(['v'], 'screen.mov', { type: '' })
    const pdf = new File(['p'], 'spec.pdf', { type: 'application/pdf' })

    expect(clipboardMedia({ items: [], files: [video, pdf] }).map((file) => file.name)).toEqual(['screen.mov'])
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

describe('streamed attachment upload', () => {
  let root = ''
  const secret = randomBytes(32)
  const now = 1_700_000_000_000

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'solus-attachment-stream-'))
  })

  afterEach(async () => {
    if (root) await rm(root, { recursive: true, force: true })
  })

  const tokenFor = async (size: number, name = 'flicker.mp4', mime = 'video/mp4') => {
    const result = await createAttachmentUploadToken(context('stream-session'), { name, mime, size }, { attachmentsDir: root, secret, now })
    return { ...result, token: result.relativeUrl.slice('/api/uploads/'.length) }
  }

  async function* chunks(...parts: Buffer[]): AsyncIterable<Uint8Array> {
    for (const part of parts) yield part
  }

  /** Only slot locks may remain in the bucket: no partial file, no half target. */
  const bucketFiles = async (hostPath: string) => (await readdir(dirname(hostPath))).filter((name) => !name.startsWith('.slot-'))

  test('streams exactly the declared bytes into the path the token named', async () => {
    const bytes = Buffer.from('fake mp4 bytes')
    const { token, hostPath, relativeUrl, expiresAt } = await tokenFor(bytes.length)

    expect(relativeUrl.startsWith('/api/uploads/')).toBe(true)
    expect(expiresAt).toBe(now + ATTACHMENT_UPLOAD_TOKEN_TTL_MS)
    expect(relative(root, hostPath).split('/')).toHaveLength(2)
    const response = await receiveAttachmentUpload(token, { contentLength: String(bytes.length), body: chunks(bytes.subarray(0, 4), bytes.subarray(4)) }, { secret, now })

    expect(response.status).toBe(204)
    expect(await readFile(hostPath)).toEqual(bytes)
    expect(await bucketFiles(hostPath)).toEqual([hostPath.split('/').pop()!])
  })

  test('the stored video keeps a playable extension when the picker omits it or the name is truncated', async () => {
    for (const name of ['recording', 'recording.bin', `${'x'.repeat(100)}.mp4`]) {
      const { hostPath } = await tokenFor(1, name, 'video/mp4')
      expect(hostPath.endsWith('.mp4')).toBe(true)
    }
  })

  test('a retry after a lost success response succeeds without replacing the file', async () => {
    const bytes = Buffer.from('first')
    const { token, hostPath } = await tokenFor(bytes.length)
    await receiveAttachmentUpload(token, { contentLength: '5', body: chunks(bytes) }, { secret, now })

    const again = await receiveAttachmentUpload(token, { contentLength: '5', body: chunks(Buffer.from('twice')) }, { secret, now })

    expect(again.status).toBe(204)
    expect(await readFile(hostPath)).toEqual(bytes)
  })

  test('refuses a Content-Length other than the size in the token', async () => {
    const { token, hostPath } = await tokenFor(10)
    for (const contentLength of [undefined, '9', '11', '1e1']) {
      const response = await receiveAttachmentUpload(token, { contentLength, body: chunks(Buffer.alloc(10)) }, { secret, now })
      expect(response.status).toBe(400)
    }
    expect(existsSync(hostPath)).toBe(false)
  })

  test('refuses an expired or tampered token', async () => {
    const { token, hostPath } = await tokenFor(3)
    const expired = await receiveAttachmentUpload(token, { contentLength: '3', body: chunks(Buffer.from('abc')) }, { secret, now: now + ATTACHMENT_UPLOAD_TOKEN_TTL_MS })
    const [payload, signature] = token.split('.')
    const grown = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(payload, 'base64url').toString()), size: 4 })).toString('base64url')
    const tampered = await receiveAttachmentUpload(`${grown}.${signature}`, { contentLength: '4', body: chunks(Buffer.from('abcd')) }, { secret, now })
    const otherHost = await receiveAttachmentUpload(token, { contentLength: '3', body: chunks(Buffer.from('abc')) }, { secret: randomBytes(32), now })

    expect([expired.status, tampered.status, otherHost.status]).toEqual([403, 403, 403])
    expect(existsSync(hostPath)).toBe(false)
  })

  // One secret signs both capabilities. A read URL for an agent's image must
  // not become a way to write a file, and an upload URL must not read one.
  test('an asset read token and an upload token are not interchangeable', async () => {
    const target = join(root, 'target.mp4')
    const assetToken = signToken({ path: target, expiresAt: now + 60_000 }, secret)
    const asUpload = await receiveAttachmentUpload(assetToken, { contentLength: '3', body: chunks(Buffer.from('abc')) }, { secret, now })
    expect(asUpload.status).toBe(403)
    expect(existsSync(target)).toBe(false)

    const { token } = await tokenFor(3)
    const asRead = await serveAssetToken(token, { method: 'GET' }, { secret, now })
    expect(asRead.status).toBe(403)
  })

  test('aborts a body larger than declared and leaves no partial file', async () => {
    const { token, hostPath } = await tokenFor(4)
    const response = await receiveAttachmentUpload(token, { contentLength: '4', body: chunks(Buffer.from('abc'), Buffer.from('def')) }, { secret, now })

    expect(response.status).toBe(413)
    expect(await bucketFiles(hostPath)).toEqual([])
  })

  test('a stream that fails midway leaves no partial file, and the client may retry', async () => {
    const { token, hostPath } = await tokenFor(6)
    async function* broken(): AsyncIterable<Uint8Array> {
      yield Buffer.from('abc')
      throw new Error('socket closed')
    }
    await expect(receiveAttachmentUpload(token, { contentLength: '6', body: broken() }, { secret, now })).rejects.toThrow('socket closed')
    expect(await bucketFiles(hostPath)).toEqual([])

    const short = await receiveAttachmentUpload(token, { contentLength: '6', body: chunks(Buffer.from('abc')) }, { secret, now })
    expect(short.status).toBe(400)
    expect(await bucketFiles(hostPath)).toEqual([])

    const retry = await receiveAttachmentUpload(token, { contentLength: '6', body: chunks(Buffer.from('abcdef')) }, { secret, now })
    expect(retry.status).toBe(204)
  })

  test('videos may be up to 50 MB; other files keep the 10 MB limit', async () => {
    await expect(tokenFor(MAX_VIDEO_UPLOAD_BYTES)).resolves.toBeTruthy()
    await expect(tokenFor(MAX_VIDEO_UPLOAD_BYTES + 1)).rejects.toThrow('50 MB')
    await expect(tokenFor(MAX_ATTACHMENT_UPLOAD_BYTES + 1, 'dump.bin', 'application/octet-stream')).rejects.toThrow('10 MB')
    await expect(tokenFor(0)).rejects.toThrow()
  })

  test('unused tokens spend no slots, while simultaneous uploads enforce the count cap', async () => {
    const tokens = await Promise.all(Array.from({ length: MAX_ATTACHMENT_UPLOAD_COUNT + 2 }, () => tokenFor(1)))
    const results = await Promise.all(tokens.map(({ token }) => receiveAttachmentUpload(
      token, { contentLength: '1', body: chunks(Buffer.from('x')) }, { secret, now },
    )))
    expect(results.filter((result) => result.status === 204)).toHaveLength(MAX_ATTACHMENT_UPLOAD_COUNT)
    expect(results.filter((result) => result.status === 409)).toHaveLength(2)
  })

  test('failed uploads give their slots back for a fresh token', async () => {
    for (let index = 0; index < MAX_ATTACHMENT_UPLOAD_COUNT + 1; index++) {
      const { token } = await tokenFor(2)
      const response = await receiveAttachmentUpload(token, { contentLength: '2', body: chunks(Buffer.from('x')) }, { secret, now })
      expect(response.status).toBe(400)
    }
    const { token } = await tokenFor(1)
    expect((await receiveAttachmentUpload(token, { contentLength: '1', body: chunks(Buffer.from('x')) }, { secret, now })).status).toBe(204)
  })

  test('refuses a token with neither a session nor a draft behind it', async () => {
    await expect(createAttachmentUploadToken(context(''), { name: 'a.mp4', mime: 'video/mp4', size: 1 }, { attachmentsDir: root, secret, now })).rejects.toThrow('A conversation is required')
  })
})

test('a removed upload does not start sending after token renewal completes', async () => {
  const abort = new AbortController()
  abort.abort()
  await expect(postAttachmentBytes({
    url: 'https://host/api/uploads/token',
    body: new Blob(['video']),
    signal: abort.signal,
    onProgress: () => {},
  })).rejects.toMatchObject({ name: 'AbortError' })
})
