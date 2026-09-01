import { readFile, realpath } from 'fs/promises'
import { join, resolve } from 'path'
import { MAX_ATTACHMENT_UPLOAD_BYTES } from '@solus/contracts/rpc'
import type { PromptImageRef, PromptOptions } from '@solus/contracts/types'
import { dataDir } from '../platform/paths'
import { isInsideRoot } from '../paths'

/** Only files this host minted through `attachUpload` are readable as refs — a
 *  ref names a path, and a path from a client is untrusted input. */
function attachmentsRoot(overrideDir?: string): string {
  return overrideDir ?? join(dataDir(), 'attachments')
}

async function readRef(ref: PromptImageRef, root: string): Promise<{ mimeType: string; dataUrl: string }> {
  if (!/^image\/[a-z0-9.+-]+$/i.test(ref.mimeType)) {
    throw new Error('The attachment MIME type is invalid.')
  }
  let target: string
  let allowedRoot: string
  try {
    target = await realpath(resolve(ref.hostPath))
    allowedRoot = await realpath(root)
  } catch {
    throw new Error('The attached image is no longer available.')
  }
  if (!isInsideRoot(allowedRoot, target)) {
    throw new Error('The attached image is outside this host\'s attachment store.')
  }
  const bytes = await readFile(target).catch(() => {
    throw new Error('The attached image is no longer available.')
  })
  if (bytes.length > MAX_ATTACHMENT_UPLOAD_BYTES) {
    throw new Error('Attachments can be up to 10 MB each.')
  }
  return { mimeType: ref.mimeType, dataUrl: `data:${ref.mimeType};base64,${bytes.toString('base64')}` }
}

/**
 * The provider-facing image blocks for one turn. Refs are read from disk here,
 * at the dispatch boundary, so `PromptOptions.imageAttachments` keeps carrying
 * only what an older client actually sent inline — the transcript event and the
 * queue preview stay free of base64.
 */
export async function resolvePromptImages(
  options: Pick<PromptOptions, 'imageAttachments' | 'imageAttachmentRefs'>,
  attachmentsDir?: string,
): Promise<PromptOptions['imageAttachments']> {
  const refs = options.imageAttachmentRefs
  if (!refs?.length) return options.imageAttachments
  const root = attachmentsRoot(attachmentsDir)
  const resolved = await Promise.all(refs.map((ref) => readRef(ref, root)))
  // An older client can send both: inline images it could not upload, plus refs
  // for the ones it could. Composer order puts the uploads last.
  return [...(options.imageAttachments ?? []), ...resolved]
}
