import { z } from 'zod'
import type { Attachment } from '@solus/contracts/types'

/**
 * Copying a message's media puts three things on the clipboard. `text/html`
 * carries a reference to the host files, which the Solus composer reads back
 * to attach the same files without uploading them again. `image/png` carries a
 * lone picture's bytes, for any other app. `text/plain` names what was copied.
 *
 * The reference rides in HTML because it is the one rich type every browser
 * and Electron write and read, and the phone can read back: a custom MIME
 * type needs the `web ` prefix, which Safari does not support.
 *
 * Desktop and web write it (`workspace-ui/lib/attachment-clipboard.ts`);
 * desktop, web, and the phone's composer read it.
 */
const REFERENCE_ATTRIBUTE = 'data-solus-attachments'
const REFERENCE_PATTERN = new RegExp(`${REFERENCE_ATTRIBUTE}="([^"]*)"`)

/** One host file a copied message carried. A path names nothing without its host. */
export interface ClipboardAttachmentRef {
  type: 'image' | 'file'
  name: string
  mimeType?: string
  size?: number
  hostPath: string
  /** The copying client's own id for the host: it names the host only on that client. */
  hostServerId: string
  /** The host's installation id, which every client knows it by. */
  hostInstallationId?: string
}

/** The copied message's attachments a composer can attach again: each one a
 *  host holds. A browser annotation is a capture of its page, not a file. */
export function clipboardAttachmentRefs(
  attachments: readonly Attachment[],
  hostPathOf: (attachment: Attachment) => string | null,
  serverIdOf: (attachment: Attachment) => string,
  installationIdOf: (serverId: string) => string | null,
): ClipboardAttachmentRef[] {
  return attachments.flatMap((attachment) => {
    if (attachment.type === 'design-selection') return []
    const hostPath = hostPathOf(attachment)
    if (!hostPath) return []
    const ref: ClipboardAttachmentRef = {
      type: attachment.type,
      name: attachment.name,
      hostPath,
      hostServerId: serverIdOf(attachment),
    }
    const installationId = installationIdOf(ref.hostServerId)
    if (installationId) ref.hostInstallationId = installationId
    if (attachment.mimeType) ref.mimeType = attachment.mimeType
    if (attachment.size !== undefined) ref.size = attachment.size
    return [ref]
  })
}

export function attachmentClipboardHtml(refs: readonly ClipboardAttachmentRef[], label: string): string {
  const encoded = encodeURIComponent(JSON.stringify(refs))
  const text = label.replace(/[&<>"]/g, (character) => `&#${character.charCodeAt(0)};`)
  return `<span ${REFERENCE_ATTRIBUTE}="${encoded}">${text}</span>`
}

/** One reference as the clipboard carries it; anything else is not a copy of ours. */
const clipboardRefSchema = z.object({
  type: z.enum(['image', 'file']),
  name: z.string(),
  mimeType: z.string().optional(),
  size: z.number().optional(),
  hostPath: z.string().min(1),
  hostServerId: z.string().min(1),
  hostInstallationId: z.string().min(1).optional(),
})
const clipboardRefsSchema = z.array(clipboardRefSchema).min(1)

/** The references a pasted HTML fragment carries, or null when Solus did not
 *  write it. A malformed reference is not a paste of ours either. */
export function parseAttachmentClipboardHtml(html: string): ClipboardAttachmentRef[] | null {
  const match = REFERENCE_PATTERN.exec(html)
  if (!match) return null
  try {
    const parsed = clipboardRefsSchema.safeParse(JSON.parse(decodeURIComponent(match[1]!)))
    return parsed.success ? parsed.data : null
  } catch {
    return null
  }
}

/** The host a composer sends to, by the names this client knows it by. */
export interface PasteTargetHost {
  /** This client's own id for the host; absent on a client whose ids are installation ids. */
  serverId?: string
  installationId: string | null
}

/**
 * Whether the composer's host holds every referenced file. The installation id
 * decides when both sides know it, because each client names hosts its own way
 * (the desktop calls its own host `local`). A client-local id matches only on
 * the client that copied.
 */
export function refsMatchHost(refs: readonly ClipboardAttachmentRef[], host: PasteTargetHost): boolean {
  return refs.every((ref) => ref.hostInstallationId && host.installationId
    ? ref.hostInstallationId === host.installationId
    : host.serverId !== undefined && ref.hostServerId === host.serverId)
}
