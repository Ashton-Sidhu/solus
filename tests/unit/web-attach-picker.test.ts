import { afterEach, describe, expect, mock, test } from 'bun:test'

// iOS Safari opens a file picker only inside the tap that asked for it, and
// WebKit can drop the `change` of a detached input. These tests pin both.

class FakeInput extends EventTarget {
  type = ''
  multiple = false
  hidden = false
  files: File[] | null = null
  isInDocument = false
  clicks = 0
  click() { this.clicks++ }
  remove() { this.isInDocument = false }
}

let lastInput: FakeInput | null = null
const originalDocument = globalThis.document

function installFakeDocument() {
  Reflect.set(globalThis, 'document', {
    createElement: () => (lastInput = new FakeInput()),
    body: { append: (input: FakeInput) => { input.isInDocument = true } },
  })
}

afterEach(() => {
  Reflect.set(globalThis, 'document', originalDocument)
  lastInput = null
})

describe('pickFiles', () => {
  test('keeps the input in the document until the user has chosen', async () => {
    installFakeDocument()
    const { pickFiles } = await import('@solus/client-core/file-picker')
    const picking = pickFiles()
    const input = lastInput!
    expect(input.clicks).toBe(1)
    expect(input.isInDocument).toBe(true)

    const file = new File(['x'], 'photo.jpg')
    input.files = [file]
    input.dispatchEvent(new Event('change'))
    expect(await picking).toEqual([file])
    expect(input.isInDocument).toBe(false)
  })

  test('resolves empty and cleans up when the user cancels', async () => {
    installFakeDocument()
    const { pickFiles } = await import('@solus/client-core/file-picker')
    const picking = pickFiles()
    lastInput!.dispatchEvent(new Event('cancel'))
    expect(await picking).toEqual([])
    expect(lastInput!.isInDocument).toBe(false)
  })
})

describe('web attach', () => {
  test('opens the picker in the same tap, before host capabilities are awaited', async () => {
    let pickerOpenedSynchronously = false
    let isInsideTap = true
    let resolveCapabilities: (value: { attachUpload: boolean }) => void = () => {}
    mock.module('@solus/client-core/file-picker', () => ({
      pickFiles: () => {
        pickerOpenedSynchronously = isInsideTap
        return Promise.resolve([])
      },
    }))
    mock.module('@solus/client-core/server-connections', () => ({
      serverConnections: {
        runOnHostId: () => 'host-1',
        apiFor: () => ({}),
        // Not known yet: the attach must not wait on this before picking.
        cachedCapabilitiesFor: () => undefined,
        capabilitiesFor: () => new Promise((resolve) => { resolveCapabilities = resolve }),
        connectionFor: () => undefined,
      },
    }))
    mock.module('@solus/workspace-ui/lib/toasts', () => ({ toasts: { info: () => {}, error: () => {} } }))
    mock.module('@solus/workspace-ui/contexts/connections/servers.store.svelte', () => ({
      serversStore: { hostFor: () => undefined },
    }))
    mock.module('@solus/workspace-ui/components/input/lib/attachment-uploads.svelte', () => ({
      uploadFileObjects: () => Promise.resolve([]),
    }))
    const { createWebAttachments } = await import('../../apps/client/src/components/input/lib/attachments')
    const session = {
      focusedSourceId: null,
      activeTabId: null,
      ctx: {},
      drafts: { sessionDrafts: new Map() },
    }
    // SAFETY: the attach reads only the fields above when no tab is targeted.
    const attachments = createWebAttachments(session as never)
    const attaching = attachments.attachFile()
    isInsideTap = false
    resolveCapabilities({ attachUpload: true })
    await attaching
    expect(pickerOpenedSynchronously).toBe(true)
  })
})
