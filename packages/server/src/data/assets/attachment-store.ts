import { createHash, randomBytes } from 'crypto'
import { chmod, copyFile, mkdir, open, unlink } from 'fs/promises'
import { basename, dirname, join } from 'path'
import { z } from 'zod'
import type { AttachmentUploadRequest } from '@solus/contracts/rpc'
import { MAX_ATTACHMENT_UPLOAD_BYTES, MAX_ATTACHMENT_UPLOAD_COUNT } from '@solus/contracts/rpc'
import { VIDEO_FILE_EXTENSIONS, videoMimeType } from '@solus/contracts/media-types'
import { dataDir } from '../../platform/paths'
import { memberUsers } from '../../host/member-users'

/**
 * The host's attachment store: files a client or another host uploaded for a
 * conversation, one folder per conversation. A prompt's image refs name files
 * here, and a run reads an image only from here (`resolvePromptImages`).
 */

export function attachmentsRoot(): string {
  return sharedFilesRoot() ?? join(dataDir(), 'attachments')
}

/**
 * Where each member is their own Linux user, the files the server hands to an
 * agent by path (docs/plans/member-isolation.md §5): `<shared>/files`, which the
 * host object made `solus:solus-proj` 2710. A member opens a path they were given
 * but cannot list the folder. Null on every other host.
 */
function sharedFilesRoot(): string | null {
  const shared = memberUsers()?.layout()?.shared
  return shared ? join(shared, 'files') : null
}

/**
 * A folder in it: its name or a path is the member's key, so they may enter, not
 * list. Setgid, so the files in it keep the `solus-proj` group that lets members
 * read them: a mode without it would give them the server's own group.
 */
const SHARED_FOLDER_MODE = 0o2710

/** An uploaded file: the server's own, or, where it is handed to members, readable by their group. */
export function attachmentFileMode(): number {
  return sharedFilesRoot() ? 0o640 : 0o600
}

/**
 * A file the server keeps (a large screenshot), as a path an agent can open:
 * where each member is their own user, a copy in a new random folder of the
 * shared files; elsewhere the file itself.
 */
export async function agentReadablePath(path: string): Promise<string> {
  const root = sharedFilesRoot()
  if (!root) return path
  const folder = join(root, randomBytes(12).toString('hex'))
  await mkdir(folder, { mode: SHARED_FOLDER_MODE })
  await chmod(folder, SHARED_FOLDER_MODE)
  const copy = join(folder, basename(path))
  await copyFile(path, copy)
  await chmod(copy, 0o640)
  return copy
}

/** An image ref as it crosses a process or a host. */
export const promptImageRefSchema = z.object({ mimeType: z.string(), hostPath: z.string(), name: z.string().optional() })

export function uploadFolderName(bucketId: string): string {
  const label = bucketId.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 48) || 'session'
  const digest = createHash('sha256').update(bucketId).digest('hex').slice(0, 12)
  return `${label}-${digest}`
}

function safeFileName(name: string): string {
  const leaf = basename(name.replaceAll('\\', '/'))
  return leaf.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 96) || 'attachment'
}

/** The first bytes of each image type a guest may upload. */
const IMAGE_SIGNATURES: ReadonlyArray<{ mime: string; matches: (head: Uint8Array) => boolean }> = [
  { mime: 'image/png', matches: (head) => [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((byte, index) => head[index] === byte) },
  { mime: 'image/jpeg', matches: (head) => head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff },
  { mime: 'image/gif', matches: (head) => head[0] === 0x47 && head[1] === 0x49 && head[2] === 0x46 && head[3] === 0x38 },
  { mime: 'image/webp', matches: (head) => String.fromCharCode(...head.slice(0, 4)) === 'RIFF' && String.fromCharCode(...head.slice(8, 12)) === 'WEBP' },
]

/**
 * What a link guest may upload (docs/plans/custom-roles.md §8): an image only
 * when its first bytes are the type it claims, and never an image type that can
 * carry script, such as SVG. Any other file is stored as bytes; nothing on the
 * host runs it, and assets are served with `nosniff` and a closed CSP.
 */
export function assertGuestAttachment(mime: string, head: Uint8Array): void {
  const signature = guestImageSignature(mime)
  if (signature && !signature.matches(head)) throw new Error('This file is not the image type it claims to be.')
}

/** The type check alone, before the bytes arrive: a guest's image must be one of the types it may send. */
export function guestImageSignature(mime: string): (typeof IMAGE_SIGNATURES)[number] | null {
  const type = mime.toLowerCase()
  if (!type.startsWith('image/')) return null
  const signature = IMAGE_SIGNATURES.find((candidate) => candidate.mime === type)
  if (!signature) throw new Error('A guest can attach PNG, JPEG, GIF, or WebP images.')
  return signature
}

export function assertAttachmentMime(mime: string): void {
  if (!/^[a-z0-9][a-z0-9!#$&^_.+/-]{0,126}$/i.test(mime)) {
    throw new Error('Invalid attachment MIME type.')
  }
}

function decodeAttachmentDataUrl(request: AttachmentUploadRequest): Buffer {
  assertAttachmentMime(request.mime)
  const match = request.dataUrl.match(/^data:([^;,]+);base64,([a-zA-Z0-9+/]*={0,2})$/)
  if (!match || match[1].toLowerCase() !== request.mime.toLowerCase()) {
    throw new Error('Invalid attachment data URL.')
  }
  const base64 = match[2]
  const maxBase64Length = Math.ceil(MAX_ATTACHMENT_UPLOAD_BYTES / 3) * 4
  if (base64.length > maxBase64Length) throw new Error('Attachment exceeds the 10 MB limit.')
  const buffer = Buffer.from(base64, 'base64')
  if (buffer.length > MAX_ATTACHMENT_UPLOAD_BYTES) throw new Error('Attachment exceeds the 10 MB limit.')
  return buffer
}

export async function attachmentUploadPath(
  bucketId: string,
  name: string,
  mime: string,
  attachmentsDir = attachmentsRoot(),
): Promise<string> {
  const bucketDir = join(attachmentsDir, uploadFolderName(bucketId))
  await mkdir(bucketDir, { recursive: true })
  // Its name follows from the conversation; each file in it has a random prefix that only its path tells.
  if (sharedFilesRoot()) await chmod(bucketDir, SHARED_FOLDER_MODE)

  let leaf = safeFileName(name)
  const video = videoMimeType({ name, mimeType: mime })
  if (video && videoMimeType({ name: leaf }) !== video) {
    const extension = VIDEO_FILE_EXTENSIONS.find((extension) => videoMimeType({ name: `file.${extension}` }) === video)
    if (extension) leaf += `.${extension}`
  }
  return join(bucketDir, `${randomBytes(12).toString('hex')}-${leaf}`)
}

/** Reserve when bytes arrive. Release failed uploads, but keep the slot for
 * completed files. The exclusive lock enforces the cap across concurrent calls. */
export async function reserveAttachmentSlot(bucketDir: string): Promise<() => Promise<void>> {
  for (let slot = 0; slot < MAX_ATTACHMENT_UPLOAD_COUNT; slot++) {
    const lockPath = join(bucketDir, `.slot-${slot}`)
    let lock: Awaited<ReturnType<typeof open>> | undefined
    try {
      lock = await open(lockPath, 'wx', 0o600)
      await lock.close()
    } catch (error) {
      await lock?.close().catch(() => {})
      if (error instanceof Error && 'code' in error && error.code === 'EEXIST') continue
      throw error
    }
    return () => unlink(lockPath).catch(() => {})
  }

  throw new Error(`A conversation can contain at most ${MAX_ATTACHMENT_UPLOAD_COUNT} uploaded attachments.`)
}

/** Decode and persist one attachment in a conversation's upload folder. */
export async function storeAttachment(
  bucketId: string,
  request: AttachmentUploadRequest,
  attachmentsDir?: string,
): Promise<string> {
  const buffer = decodeAttachmentDataUrl(request)
  const filePath = await attachmentUploadPath(bucketId, request.name, request.mime, attachmentsDir)
  const release = await reserveAttachmentSlot(dirname(filePath))
  let handle: Awaited<ReturnType<typeof open>> | undefined
  try {
    handle = await open(filePath, 'wx', attachmentFileMode())
    await handle.writeFile(buffer)
    await handle.close()
    return filePath
  } catch (error) {
    await handle?.close().catch(() => {})
    await unlink(filePath).catch(() => {})
    await release()
    throw error
  }
}
