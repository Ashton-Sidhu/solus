import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { execFileSync } from 'child_process'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { dirname, join } from 'path'
import sharp from 'sharp'
import type { IpcContext } from '@solus/contracts/types'
import { attachmentKind, landedAttachmentKind } from '@solus/contracts/media-types'
import { writeAttachmentUpload } from '@solus/server/transport/handlers/attachment-handlers'
import { filePathsToAttachments } from '@solus/server/transport/attachment-utils'

// WHY: an iPhone photo is HEIC, and no browser Solus runs in can draw one. Sent
// as an image, the transcript showed a broken picture. A host that can decode it
// stores a JPEG; any other host keeps it as a file chip, never a broken image.

const isMac = process.platform === 'darwin'
const context = { session: { sessionId: 'heic-session' } } as IpcContext
const JPEG_START = [0xff, 0xd8, 0xff]

let root = ''
let heic = Buffer.alloc(0)

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'solus-heic-test-'))
  if (!isMac) return
  const png = join(root, 'photo.png')
  await sharp({ create: { width: 8, height: 8, channels: 3, background: '#c0603a' } }).png().toFile(png)
  execFileSync('/usr/bin/sips', ['-s', 'format', 'heic', png, '--out', join(root, 'photo.heic')])
  heic = await readFile(join(root, 'photo.heic'))
})

afterAll(async () => {
  if (root) await rm(root, { recursive: true, force: true })
})

function heicUpload(bytes: Buffer, name = 'IMG_3464.heic') {
  return { name, mime: 'image/heic', dataUrl: `data:image/heic;base64,${bytes.toString('base64')}` }
}

describe('HEIC attachment kind', () => {
  test('a HEIC photo is a file until its host stores a JPEG', () => {
    const heicFile = { type: 'file', mimeType: 'image/heic', isVideo: false }
    expect(attachmentKind({ name: 'IMG_1.heic', mimeType: 'image/heic' })).toEqual(heicFile)
    expect(attachmentKind({ name: 'IMG_1.HEIC', mimeType: '' })).toEqual(heicFile)
    expect(attachmentKind({ name: 'pasted', mimeType: 'image/heif' })).toEqual({ ...heicFile, mimeType: 'image/heif' })
  })

  test('the attachment becomes a JPEG image only when the host answered with a JPEG', () => {
    const kind = attachmentKind({ name: 'IMG_1.heic', mimeType: 'image/heic' })
    expect(landedAttachmentKind(kind, 'IMG_1.heic', '/host/ab12-IMG_1.jpg')).toEqual({ type: 'image', mimeType: 'image/jpeg', isVideo: false })
    // A host that cannot convert keeps the HEIC, and the chip stays a file.
    expect(landedAttachmentKind(kind, 'IMG_1.heic', '/host/ab12-IMG_1.heic')).toBe(kind)
    // Any other file keeps the kind it was sent with.
    const notes = attachmentKind({ name: 'notes.txt', mimeType: 'text/plain' })
    expect(landedAttachmentKind(notes, 'notes.txt', '/host/ab12-notes.jpg')).toBe(notes)
  })
})

describe('HEIC upload on the host', () => {
  test.skipIf(!isMac)('stores an uploaded HEIC photo as a JPEG and keeps no HEIC copy', async () => {
    const path = await writeAttachmentUpload(context, heicUpload(heic), { attachmentsDir: join(root, 'uploads') })

    expect(path.endsWith('-IMG_3464.jpg')).toBe(true)
    expect([...(await readFile(path)).subarray(0, 3)]).toEqual(JPEG_START)
    expect(await readdir(dirname(path))).toHaveLength(1)
  })

  test('keeps the original when the bytes cannot be converted', async () => {
    const bytes = Buffer.from('not a photo')
    const path = await writeAttachmentUpload(context, heicUpload(bytes, 'broken.heic'), { attachmentsDir: join(root, 'broken') })

    expect(path.endsWith('-broken.heic')).toBe(true)
    expect(await readFile(path)).toEqual(bytes)
    expect(await readdir(dirname(path))).toHaveLength(1)
  })
})

describe('HEIC file on the host disk', () => {
  test.skipIf(!isMac)('attaches a JPEG copy as an image and leaves the original alone', async () => {
    const original = join(root, 'IMG_3465.HEIC')
    await writeFile(original, heic)

    const [attachment] = await filePathsToAttachments([original])

    expect(attachment).toMatchObject({ type: 'image', name: 'IMG_3465.jpg', mimeType: 'image/jpeg' })
    expect(attachment.path).not.toBe(original)
    expect(attachment.dataUrl?.startsWith('data:image/jpeg;base64,')).toBe(true)
    expect(await readFile(original)).toEqual(heic)
    await rm(dirname(attachment.path), { recursive: true, force: true })
  })
})
