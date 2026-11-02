import { describe, expect, test } from 'bun:test'
import { UPLOAD_NAME_PREFIX } from '@solus/contracts/host-path'
import { attachmentLabel } from '../../packages/workspace-ui/src/lib/attachment-label'
import { attachmentDisplayName } from '../../apps/mobile/src/features/conversation/lib/message-attachments'
import { codexItemToMessage } from '../../packages/server/src/execution/agents/codex/codex-utils'

// What another session's send_session produced: the host stores each file as
// `<24 hex>-<safe name>` and spells a space as `_`. A bubble must read the name
// the sender chose, and a reloaded Codex session must keep the pictures it sent.

describe('a stored upload reads as the name it was sent with', () => {
  test('the current 24-hex prefix and the older slot prefix both come off', () => {
    expect('2480d6cb042c24dafe22bb03-spec.pdf'.replace(UPLOAD_NAME_PREFIX, '')).toBe('spec.pdf')
    expect('3-1fa99f6980ef-spec.pdf'.replace(UPLOAD_NAME_PREFIX, '')).toBe('spec.pdf')
  })

  test('a name that only looks hex-like keeps its text', () => {
    expect('deadbeef-notes.txt'.replace(UPLOAD_NAME_PREFIX, '')).toBe('deadbeef-notes.txt')
  })

  test('a large paste reads "Pasted text" on desktop, web and mobile, as typed and as stored', () => {
    for (const name of ['pasted text 2026-11-01 120000.txt', 'pasted_text_2026-11-01_120000.txt', 'pasted_text_2026-11-01_120000_2.txt']) {
      expect(attachmentLabel({ type: 'file', name })).toBe('Pasted text')
      expect(attachmentDisplayName(name)).toBe('Pasted text')
    }
    expect(attachmentLabel({ type: 'file', name: 'pasted_text_notes.txt' })).toBe('pasted_text_notes.txt')
  })
})

describe('a reloaded Codex session keeps the pictures a user sent', () => {
  const png = 'data:image/png;base64,iVBORw0KGgo='

  test('a picture sent with words comes back with them', () => {
    const message = codexItemToMessage({ type: 'userMessage', content: [{ type: 'text', text: 'look' }, { type: 'image', url: png }] }, 1)
    expect(message).toMatchObject({ role: 'user', content: 'look', imageAttachments: [{ mimeType: 'image/png', dataUrl: png }] })
  })

  test('a picture sent alone is still a message', () => {
    const message = codexItemToMessage({ type: 'userMessage', content: [{ type: 'image', url: png }] }, 1)
    expect(message?.imageAttachments).toHaveLength(1)
  })

  test('a local image from the Codex CLI becomes a host image reference', () => {
    const message = codexItemToMessage({ type: 'userMessage', content: [{ type: 'localImage', path: '/tmp/shot.png' }] }, 1)
    expect(message?.imageAttachmentRefs).toEqual([{ mimeType: 'image/png', hostPath: '/tmp/shot.png' }])
  })

  test('a remote image URL and an empty message still give nothing to show', () => {
    expect(codexItemToMessage({ type: 'userMessage', content: [{ type: 'image', url: 'https://example.com/a.png' }] }, 1)).toBeNull()
  })
})
