import { readFile, stat } from 'fs/promises'
import { basename, resolve } from 'path'
import { MAX_ATTACHMENT_UPLOAD_BYTES, type AttachmentUploadRequest } from '@solus/contracts/rpc'
import { mediaTypeFor, mimeTypeFor } from '@solus/contracts/media-types'
import type { IpcContext, PromptImageRef, PromptOptions } from '@solus/contracts/types'
import { resolveHomePath } from '../../platform/paths'
import type { RemoteHost } from './remote-hosts'

/** Images a provider takes as an image block. Any other file goes as a path. */
const PROMPT_IMAGE_MIME_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp'])

/** Stores one file in the attachment store of the host that runs the session,
 *  in the folder `bucketId` names, and answers its path there. On this host it
 *  is `storeAttachment`. */
export type AttachmentUpload = (bucketId: string, request: AttachmentUploadRequest) => Promise<string>

/** A message's text and images, as the host that runs it receives them. */
export type AttachedPrompt = Pick<PromptOptions, 'prompt' | 'imageAttachmentRefs'>

/** The upload a client makes to that host, with the owner's connection. */
export function uploadTo(host: RemoteHost): AttachmentUpload {
  // SAFETY: attachUpload reads only the conversation an upload belongs to. A
  // message has no conversation on that host, so it names a draft.
  return (bucketId, request) => host.call('the attachment upload', () =>
    host.api.attachUpload({ session: { sessionId: '', draftId: bucketId } } as IpcContext, request))
}

/** The files an agent attached, as absolute paths on this host, or why one cannot be sent. */
export async function checkAttachments(paths: readonly string[], cwd: string): Promise<string[] | { error: string }> {
  const checked: string[] = []
  for (const requested of paths) {
    const path = resolve(cwd, resolveHomePath(requested.trim()))
    const info = await stat(path).catch(() => null)
    if (!info?.isFile()) return { error: `Attachment ${requested} is not a file on this host.` }
    if (info.size > MAX_ATTACHMENT_UPLOAD_BYTES) return { error: `Attachment ${requested} is larger than ${MAX_ATTACHMENT_UPLOAD_BYTES / 1024 / 1024} MB.` }
    checked.push(path)
  }
  return checked
}

/**
 * The prompt with its files, uploaded to the host that runs it as a client
 * uploads them: the session reads the copy taken now, even after the sender
 * changes the file. Images go as refs; other files as `[Attached file: <path>]`
 * lines before the text, the form a client composer writes and every client
 * rebuilds chips from. Each message has its own folder (`bucketId`), so a long
 * conversation never reaches the folder limit.
 */
export async function attachToPrompt(
  prompt: string,
  paths: readonly string[] | undefined,
  upload: AttachmentUpload,
  bucketId: string,
): Promise<AttachedPrompt> {
  if (!paths?.length) return { prompt }
  const files: string[] = []
  const images: PromptImageRef[] = []
  for (const path of paths) {
    const imageMime = mediaTypeFor(path)?.mime
    const isImage = imageMime !== undefined && PROMPT_IMAGE_MIME_TYPES.has(imageMime)
    const mime = isImage ? imageMime : mimeTypeFor(path) ?? 'application/octet-stream'
    const bytes = await readFile(path)
    const stored = await upload(bucketId, { name: basename(path), mime, dataUrl: `data:${mime};base64,${bytes.toString('base64')}` })
    if (isImage) images.push({ mimeType: mime, hostPath: stored, name: basename(path) })
    else files.push(stored)
  }
  const attached: AttachedPrompt = {
    prompt: files.length ? `${files.map((file) => `[Attached file: ${file}]`).join('\n')}\n\n${prompt}` : prompt,
  }
  if (images.length) attached.imageAttachmentRefs = images
  return attached
}
