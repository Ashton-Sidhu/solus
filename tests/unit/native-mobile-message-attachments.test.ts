import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { resolveMarkdownFileIcon } from '../../apps/mobile/modules/t3-markdown-text/src/markdownLinks'
import { splitAttachedFiles as desktopSplit } from '@solus/workspace-ui/contexts/workspace/session.utils'
import {
  attachmentTypeLabel,
  promptImageAttachments,
  queuedMessageAttachments,
  splitAttachedFiles,
  uploadedMessageAttachments,
} from '../../apps/mobile/src/features/conversation/lib/message-attachments'
import { TranscriptModel } from '../../apps/mobile/src/features/conversation/lib/transcript-model'

// A sent prompt's attachments render as T3 draws them (pictures, file cards),
// read from the same sources the desktop bubble reads, never as a raw
// `[Attached file: /host/path]` line or a bare count.

const composed = '[Attached file: /h/.solus/uploads/0-0123456789ab-report.pdf]\n[Attached file: /h/.solus/uploads/1-0123456789ab-clip.mp4]\n\nPlease review'

describe('native sent-prompt attachments', () => {
  test('files split out of a sent prompt by the desktop rule, names and all', () => {
    for (const content of [composed, '[Attached file: /a/b.txt]', '[Attached file: /a/b.txt]\nno blank line', 'plain text', '']) {
      const native = splitAttachedFiles(content)
      const desktop = desktopSplit(content, undefined)
      expect(native.text).toBe(desktop.text)
      expect(native.files.map((file) => file.kind === 'file' && [file.name, file.hostPath])).toEqual(desktop.attachments.map((file) => [file.name, file.path]))
    }
    const { text, files } = splitAttachedFiles(composed)
    expect(text).toBe('Please review')
    expect(files.map((file) => file.kind === 'file' && file.video)).toEqual([false, true])
  })

  test('a reloaded turn shows its pictures and files, and only the typed text', () => {
    const model = TranscriptModel.fromHistory('s', {
      messages: [{ role: 'user', content: composed, messageId: 'u1', timestamp: 1, imageAttachments: [{ mimeType: 'image/png', dataUrl: 'data:image/png;base64,AA' }] }],
      before: null,
    })
    const item = model.items.get('u1')
    expect(item?.kind === 'user' && item.text).toBe('Please review')
    expect(item?.kind === 'user' && item.attachments.map((attachment) => attachment.kind)).toEqual(['image', 'file', 'file'])
  })

  test('a live prompt from another client shows the host\'s stored pictures by path', () => {
    const model = new TranscriptModel('s')
    model.apply({ type: 'user_message', text: 'look', imageAttachmentRefs: [{ mimeType: 'image/png', hostPath: '/h/up/shot.png', name: 'shot.png' }] })
    const [item] = [...model.items.values()]
    expect(item?.kind === 'user' && item.attachments).toEqual([{ kind: 'host-image', key: 'ref:0:/h/up/shot.png', name: 'shot.png', hostPath: '/h/up/shot.png' }])
  })

  // A host stores history pictures as assets; a row a runner mirrored earlier
  // still carries a data URL. Both show, and a tool's pictures land on its row.
  test('history shows stored prompt pictures, legacy inline ones, and tool images', () => {
    const toolImage = { assetId: `${'a'.repeat(64)}.png`, mimeType: 'image/png', width: 390, height: 844 }
    const model = TranscriptModel.fromHistory('s', {
      messages: [
        { role: 'user', content: 'look', messageId: 'u1', timestamp: 1, imageAttachmentRefs: [{ mimeType: 'image/png', hostPath: '/h/.solus/assets/x.png' }], imageAttachments: [{ mimeType: 'image/png', dataUrl: 'data:image/png;base64,AA' }] },
        { role: 'tool', content: '', messageId: 't1', toolId: 'tool-1', toolName: 'mcp__solus__device_screenshot', timestamp: 2 },
        { role: 'tool_result', content: '', toolResultForId: 'tool-1', status: 'ok', toolImages: [toolImage], timestamp: 3 },
      ],
      before: null,
    })
    const user = model.items.get('u1')
    expect(user?.kind === 'user' && user.attachments.map((attachment) => attachment.kind)).toEqual(['image', 'host-image'])
    const tool = model.items.get('t1')
    expect(tool?.kind === 'tool' && tool.images).toEqual([toolImage])
  })

  test('this phone\'s own uploads show at once: bytes for pictures, host paths for files', () => {
    const shown = uploadedMessageAttachments([
      { id: 'a', kind: 'image', name: 'p.png', hostPath: '/h/p.png', mimeType: 'image/png', size: 1, dataUrl: 'data:image/png;base64,AA' },
      { id: 'b', kind: 'image', name: 'q.png', hostPath: '/h/q.png', mimeType: 'image/png', size: 1, dataUrl: null },
      { id: 'c', kind: 'file', name: 'notes.md', hostPath: '/h/0-0123456789ab-notes.md', mimeType: 'text/markdown', size: 1, dataUrl: null },
    ])
    expect(shown.map((attachment) => attachment.kind)).toEqual(['image', 'host-image', 'file'])
    expect(shown[2]).toMatchObject({ name: 'notes.md', hostPath: '/h/0-0123456789ab-notes.md' })
  })

  test('a prompt restored from the outbox keeps its pictures and host files, never a client path', () => {
    const shown = queuedMessageAttachments({
      imageAttachmentRefs: [{ mimeType: 'image/png', hostPath: '/h/p.png', name: 'p.png' }],
      queueAttachments: [
        { id: '1', type: 'file', name: 'a.txt', hostPath: '/h/a.txt' },
        { id: '2', type: 'file', name: 'local-only.txt' },
        { id: '3', type: 'design-selection', name: 'Selection', hostPath: '/h/sel' },
      ],
    })
    expect(shown.map((attachment) => [attachment.kind, attachment.name])).toEqual([['host-image', 'p.png'], ['file', 'a.txt']])
    expect(promptImageAttachments(undefined, undefined)).toEqual([])
  })

  test('a file card names its type the way T3 does', () => {
    expect(attachmentTypeLabel('report.pdf')).toBe('PDF')
    expect(attachmentTypeLabel('Makefile')).toBe('File')
  })
})

describe('native attachment presentation', () => {
  const mobile = (path: string) => readFileSync(join(import.meta.dir, '../../apps/mobile', path), 'utf8')

  test('pictures fill the user bubble\'s content box exactly: its max less its own horizontal padding', () => {
    // WHY: a width computed from a stale inset clips the picture or leaves a
    // double margin once the bubble's padding changes.
    const feed = mobile('src/features/threads/ThreadFeed.tsx')
    const padding = Number(/rounded-\[20px\] px-(\d+(?:\.\d+)?) py-/.exec(feed)![1]) * 4
    const inset = Number(/width=\{props\.userBubbleMaxWidth - (\d+)\}/.exec(feed)![1])
    expect(inset).toBe(padding * 2)
  })

  test('a file shows its type icon from T3\'s bundled Pierre set, by name', () => {
    expect(resolveMarkdownFileIcon('notes.md')).toBe('markdown')
    expect(resolveMarkdownFileIcon('shot.PNG')).toBe('image')
    expect(resolveMarkdownFileIcon('clip.mov')).toBe('video')
    expect(resolveMarkdownFileIcon('archive.zip')).toBe('zip')
    // T3 has no PDF glyph; a PDF takes the default icon there too.
    expect(resolveMarkdownFileIcon('report.pdf')).toBe('default')
    const sources = mobile('modules/t3-markdown-text/src/markdownFileIcons.generated.ts')
    for (const icon of ['markdown', 'image', 'video', 'zip', 'default']) expect(sources).toContain(`pierre_${icon}.png`)
  })
})
