import { describe, expect, test } from 'bun:test'
import type { Attachment } from '@solus/contracts/types'
import {
  attachmentClipboardHtml,
  clipboardAttachmentRefs,
  parseAttachmentClipboardHtml,
  refsMatchHost,
} from '@solus/client-core/attachment-clipboard'
import { reattachedAttachment } from '@solus/workspace-ui/lib/attachment-clipboard'
import { attachmentDownloadName } from '@solus/workspace-ui/components/conversation/lib/attachment-download'
import { copyableImage } from '../../apps/mobile/src/features/conversation/lib/message-attachments'
import { mayCarryAttachmentRefs, referencedAttachments, refsOnHost, withoutPastedText } from '../../apps/mobile/src/features/conversation/lib/pasted-attachments'
import { base64OfDataUrl } from '../../apps/mobile/src/lib/dataUrlBase64'

const image: Attachment = { id: 'a1', type: 'image', name: 'shot.png', path: '/h/u/0-0123456789ab-shot.png', hostPath: '/h/u/0-0123456789ab-shot.png', hostServerId: 'host-1', mimeType: 'image/png', size: 2048 }
const pdf: Attachment = { id: 'a2', type: 'file', name: 'spec.pdf', path: 'spec.pdf', hostPath: '/h/u/1-0123456789ab-spec.pdf' }

// Copying media sent without words must paste back as the same host files, not
// as text and not as a fresh upload, and only for a host that holds them.
describe('attachment clipboard reference', () => {
  test('a copied message round-trips through its HTML into the same host files', () => {
    const refs = clipboardAttachmentRefs([image, pdf], (a) => a.hostPath ?? null, (a) => a.hostServerId ?? 'host-1', () => 'install-1')
    const html = attachmentClipboardHtml(refs, 'shot.png, spec.pdf')
    // A browser wraps pasted HTML in its own markup; the reference survives that.
    const parsed = parseAttachmentClipboardHtml(`<meta charset="utf-8">${html}`)
    expect(parsed).toEqual(refs)
    const again = reattachedAttachment(parsed![1]!, 'new-id')
    expect(again).toEqual({ id: 'new-id', type: 'file', name: 'spec.pdf', path: pdf.hostPath!, hostPath: pdf.hostPath!, hostServerId: 'host-1' })
    expect(parsed![0]!.hostInstallationId).toBe('install-1')
  })

  test('only files a host holds are copied; a browser annotation is not a file', () => {
    const annotation: Attachment = { id: 'a3', type: 'design-selection', name: 'marks', path: '', hostPath: '/h/marks.png' }
    const local: Attachment = { id: 'a4', type: 'image', name: 'x.png', path: 'x.png', dataUrl: 'data:image/png;base64,AA' }
    expect(clipboardAttachmentRefs([annotation, local], (a) => a.hostPath ?? null, () => 'host-1', () => null)).toEqual([])
  })

  test('HTML Solus did not write, or a tampered reference, is not a paste of ours', () => {
    expect(parseAttachmentClipboardHtml('<b>hello</b>')).toBeNull()
    expect(parseAttachmentClipboardHtml('<span data-solus-attachments="not%20json"></span>')).toBeNull()
    const missingHost = encodeURIComponent(JSON.stringify([{ type: 'file', name: 'a', hostPath: '/a' }]))
    expect(parseAttachmentClipboardHtml(`<span data-solus-attachments="${missingHost}"></span>`)).toBeNull()
  })

  test('the label cannot break out of the reference markup', () => {
    const html = attachmentClipboardHtml([], '<img src=x onerror=alert(1)>')
    expect(html).not.toContain('<img')
  })
})

describe('attachment download name', () => {
  test('a download keeps the name it was sent with, never the card label', () => {
    expect(attachmentDownloadName({ name: 'pasted text 2026-10-31 142233.txt', path: 'x', hostPath: '/h/x' })).toBe('pasted text 2026-10-31 142233.txt')
  })
  test('a nameless attachment takes the host file name without the upload prefix', () => {
    expect(attachmentDownloadName({ name: '', path: '', hostPath: '/h/.solus/uploads/3-0123456789ab-report.pdf' })).toBe('report.pdf')
    expect(attachmentDownloadName({ name: ' ', path: '' })).toBe('attachment')
  })
})

describe('native picture copy', () => {
  const picture = { kind: 'host-image' as const, key: 'r', name: 'shot.png', hostPath: '/h/shot.png' }
  test('only a lone picture sent without words copies; the clipboard holds one image', () => {
    expect(copyableImage([picture], false)).toBe(picture)
    expect(copyableImage([picture], true)).toBeNull()
    expect(copyableImage([picture, picture], false)).toBeNull()
    expect(copyableImage([{ kind: 'file', key: 'v', name: 'clip.mp4', hostPath: '/h/clip.mp4', video: true }], false)).toBeNull()
  })
  test('a data URL gives its base64 bytes', () => {
    expect(base64OfDataUrl('data:image/png;base64,iVBORw0KGgo=')).toBe('iVBORw0KGgo=')
    expect(base64OfDataUrl('data:text/plain,hello')).toBeNull()
  })
})

// A copy names its host two ways; the paste must land only on the host that
// holds the files, whichever client pastes it.
describe('pasting a copy on the host that holds it', () => {
  const ref = { type: 'file' as const, name: 'spec.pdf', hostPath: '/h/spec.pdf', hostServerId: 'local', hostInstallationId: 'install-1' }

  test('the installation id decides when both sides know it, across clients', () => {
    // The desktop calls its own host `local`; another client calls it by its installation id.
    expect(refsMatchHost([ref], { serverId: 'local', installationId: 'install-2' })).toBe(false)
    expect(refsMatchHost([ref], { serverId: 'other', installationId: 'install-1' })).toBe(true)
  })

  test('without an installation id, only the copying client\'s own host id matches', () => {
    const bare = { ...ref, hostInstallationId: undefined }
    expect(refsMatchHost([bare], { serverId: 'local', installationId: 'install-1' })).toBe(true)
    expect(refsMatchHost([bare], { installationId: 'install-1' })).toBe(false)
  })

  test('the phone matches by its host id, which is the installation id', () => {
    expect(refsOnHost([ref], 'install-1')).toBe(true)
    expect(refsOnHost([ref], 'install-2')).toBe(false)
    expect(refsOnHost([ref, { ...ref, hostInstallationId: 'install-2' }], 'install-1')).toBe(false)
  })

  test('the phone attaches the same host files, with nothing to upload', () => {
    const [attached] = referencedAttachments([{ ...ref, type: 'image', name: 'shot.png' }], () => 'id-1')
    expect(attached).toEqual({ id: 'id-1', kind: 'image', name: 'shot.png', hostPath: '/h/spec.pdf', mimeType: 'image/png', size: 0, dataUrl: null })
  })

  test('only a paste that could be a copy reads the clipboard HTML', () => {
    expect(mayCarryAttachmentRefs({ type: 'images' })).toBe(true)
    expect(mayCarryAttachmentRefs({ type: 'text', value: 'shot.png, Pasted text' })).toBe(true)
    expect(mayCarryAttachmentRefs({ type: 'text', value: 'fix the login bug' })).toBe(false)
    expect(mayCarryAttachmentRefs({ type: 'unsupported' })).toBe(false)
  })

  test('the names the field pasted come back out of the draft', () => {
    expect(withoutPastedText('look at shot.png', 'shot.png')).toBe('look at ')
    expect(withoutPastedText('unchanged', 'shot.png')).toBe('unchanged')
  })
})
