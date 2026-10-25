import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { IpcContext } from '@solus/contracts/types'
import { assertGuestAttachment } from '@solus/server/data/assets/attachment-store'
import { createAttachmentUploadToken, receiveAttachmentUpload } from '@solus/server/transport/handlers/attachment-handlers'

// docs/plans/custom-roles.md §8: a guest's image must be the type it claims, and a
// type that can carry script is refused.

const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13])
const SVG = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>')
const SECRET = Buffer.alloc(32, 7)
const ctx = { session: { sessionId: 's1' } } as IpcContext

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'solus-guest-attach-')) })
afterEach(() => rmSync(dir, { recursive: true, force: true }))

async function* bodyOf(bytes: Uint8Array) { yield bytes }

describe('guest attachments', () => {
  test('an image passes only when its bytes are the type it claims; SVG never does; other files are bytes', () => {
    expect(() => assertGuestAttachment('image/png', PNG)).not.toThrow()
    expect(() => assertGuestAttachment('image/png', SVG)).toThrow(/not the image type/)
    expect(() => assertGuestAttachment('image/svg+xml', SVG)).toThrow(/PNG, JPEG, GIF, or WebP/)
    expect(() => assertGuestAttachment('text/plain', SVG)).not.toThrow()
  })

  test('a streamed upload from a guest is refused when its bytes are not its type, and nothing is stored', async () => {
    // WHY: the type check at the token is only the claim; the bytes decide. A stored
    // file named .png that holds script must never land in the session's uploads.
    const token = await createAttachmentUploadToken(ctx, { name: 'a.png', mime: 'image/png', size: SVG.byteLength }, { attachmentsDir: dir, secret: SECRET, fromGuest: true })
    const refused = await receiveAttachmentUpload(token.relativeUrl.split('/').pop()!, { contentLength: String(SVG.byteLength), body: bodyOf(SVG) }, { secret: SECRET })
    expect(refused.status).toBe(415)
    expect(existsSync(token.hostPath)).toBe(false)

    const good = await createAttachmentUploadToken(ctx, { name: 'b.png', mime: 'image/png', size: PNG.byteLength }, { attachmentsDir: dir, secret: SECRET, fromGuest: true })
    const stored = await receiveAttachmentUpload(good.relativeUrl.split('/').pop()!, { contentLength: String(PNG.byteLength), body: bodyOf(PNG) }, { secret: SECRET })
    expect(stored.status).toBe(204)
    expect(existsSync(good.hostPath)).toBe(true)
  })

  test('a guest cannot even ask to upload an SVG; a member still can', async () => {
    await expect(createAttachmentUploadToken(ctx, { name: 'a.svg', mime: 'image/svg+xml', size: SVG.byteLength }, { attachmentsDir: dir, secret: SECRET, fromGuest: true })).rejects.toThrow(/PNG, JPEG, GIF, or WebP/)
    await expect(createAttachmentUploadToken(ctx, { name: 'a.svg', mime: 'image/svg+xml', size: SVG.byteLength }, { attachmentsDir: dir, secret: SECRET })).resolves.toMatchObject({ expiresAt: expect.any(Number) })
  })
})
