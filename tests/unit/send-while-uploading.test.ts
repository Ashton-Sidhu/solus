import { afterAll, describe, expect, mock, test } from 'bun:test'
import type { Attachment, Session } from '@solus/contracts/types'
import { folderLocation } from '@solus/workspace-ui/contexts/workspace/run-location'

mock.module('@solus/workspace-ui/contexts/notifications/notifications.store.svelte', () => ({ notificationsStore: {} }))
mock.module('@solus/workspace-ui/contexts/connections/servers.store.svelte', () => ({ serversStore: {} }))
const toastErrors: string[] = []
mock.module('svelte-sonner', () => ({
  toast: Object.assign(() => '', { success: () => '', info: () => '', error: (message: string) => { toastErrors.push(message); return '' }, dismiss: () => {} }),
}))
// The stores this module reaches are plain objects here: no test reads their reactivity.
const runes = globalThis as unknown as { $state?: unknown; $derived?: unknown; $effect?: unknown }
const previousRunes = { $state: runes.$state, $derived: runes.$derived, $effect: runes.$effect }
runes.$state = Object.assign(<T>(value: T) => value, { snapshot: <T>(value: T) => value, raw: <T>(value: T) => value })
runes.$derived = Object.assign(<T>(value: T) => value, { by: <T>(fn: () => T) => fn() })
runes.$effect = Object.assign(() => {}, { root: () => () => {}, pre: () => {}, tracking: () => false })
afterAll(() => Object.assign(runes, previousRunes))
const { PromptDispatch } = await import('@solus/workspace-ui/contexts/workspace/prompt-dispatch')
const { PromptComposer } = await import('@solus/workspace-ui/contexts/workspace/prompt-composer')
const { attachmentUploads } = await import('@solus/workspace-ui/components/input/lib/attachment-uploads.svelte')

// Send works while a file uploads (T3 Code #33092). The message shows at once
// and the composer clears, but the turn reaches the host only when the file is
// there: the prompt names the file by its host path. A failed upload sends
// nothing and gives the user back what they wrote.

type SentTurn = { prompt: string; displayPrompt: string; clientPromptId?: string }

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}

let nextId = 0
function fileChip(): Attachment {
  nextId += 1
  return { id: `chip-${nextId}`, type: 'file', name: 'spec.pdf', path: 'spec.pdf', hostServerId: 'remote-host', mimeType: 'application/pdf', size: 10 }
}

/** A file whose upload ends when the test says so. */
function uploadingFile() {
  const chip = fileChip()
  const upload = deferred<Attachment | null>()
  const held = attachmentUploads.hold(chip.id, 10, () => upload.promise).catch(() => undefined)
  return {
    chip,
    land: async () => { upload.resolve({ ...chip, path: '/host/spec.pdf', hostPath: '/host/spec.pdf' }); await held },
    fail: async () => { upload.reject(new Error('offline')); await held },
  }
}

function harness(opts: { status?: Session['status'] } = {}) {
  const turns: SentTurn[] = []
  const errors: string[] = []
  const session = {
    id: 'session-1',
    status: opts.status ?? 'idle',
    agentSessionId: null,
    messages: [],
    outboundPrompts: [],
    prompt: { text: '', attachments: [], planRefs: [], workRefs: [], sessionRefs: [] },
    title: 'New session',
    task: { kind: 'none' },
    run: { location: folderLocation({ serverId: 'remote-host', path: '/repo' }), provider: 'claude-code', permissionMode: 'supervised' },
  } as unknown as Session
  const workspace = {
    sessionFor: () => session,
    promptComposer: new PromptComposer({} as never, {} as never),
    settings: { activeAgent: 'claude-code' },
    tasksStore: { taskForSession: () => null },
    eventReducer: {
      closeAgentConversationTurn: () => {},
      handleError: (_sessionId: string, error: { message: string }) => {
        errors.push(error.message)
        session.status = 'failed'
      },
    },
  }
  const dispatch = new PromptDispatch(workspace as never)
  const internal = dispatch as unknown as {
    promptTab: (tabId: string, options: SentTurn) => void
    dispatchPrompt: (tabId: string, session: Session, prompt: string, resolvedPath: string, delivery: 'steer' | 'queue') => boolean
  }
  internal.promptTab = (_tabId, options) => { turns.push(options) }
  const send = (text: string) => {
    // Dispatch asks the conversation to scroll with a DOM event; nothing listens here.
    const scope = globalThis as unknown as { window?: unknown }
    const previousWindow = scope.window
    scope.window = { dispatchEvent: () => true }
    try {
      return internal.dispatchPrompt('tab-1', session, text, '/repo', 'steer')
    } finally {
      scope.window = previousWindow
    }
  }
  return { session, turns, errors, send }
}

/** Let every queued step of the send run. */
async function settle(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve()
}

describe('send while an attachment uploads', () => {
  test('the message shows and the composer clears at once; the turn starts when the upload lands', async () => {
    const { session, turns, send } = harness()
    const file = uploadingFile()
    session.prompt.attachments.push(file.chip)

    expect(attachmentUploads.sendBlocker(session.prompt.attachments)).toBeNull()
    expect(send('Review this')).toBe(true)
    expect(session.messages.map((message) => message.content)).toEqual(['Review this'])
    expect(session.prompt.attachments).toEqual([])
    expect(session.currentActivity).toBe('Uploading attachments...')
    await settle()
    expect(turns).toEqual([])

    await file.land()
    await settle()
    expect(turns).toHaveLength(1)
    // The host can open the file: the prompt names the path the upload gave it.
    expect(turns[0]?.prompt).toContain('/host/spec.pdf')
    expect(session.messages[0]?.attachments?.[0]?.hostPath).toBe('/host/spec.pdf')
    expect(session.currentActivity).toBe('Starting session...')
  })

  test('a later send waits behind the one that waits for its upload, so the host gets them in order', async () => {
    const { session, turns, send } = harness()
    const file = uploadingFile()
    session.prompt.attachments.push(file.chip)
    send('First, with a file')
    send('Second, text only')
    await settle()
    expect(turns).toEqual([])

    await file.land()
    await settle()
    expect(turns.map((turn) => turn.displayPrompt)).toEqual(['First, with a file', 'Second, text only'])
  })

  test('a failed upload sends nothing, says why, and gives back the text and the file', async () => {
    const { session, turns, errors, send } = harness()
    const file = uploadingFile()
    const doneFile: Attachment = { ...fileChip(), name: 'notes.txt', path: '/host/notes.txt', hostPath: '/host/notes.txt' }
    session.prompt.attachments.push(doneFile, file.chip)
    send('Review this')

    await file.fail()
    await settle()
    expect(turns).toEqual([])
    expect(errors).toHaveLength(1)
    expect(errors[0]).toContain('offline')
    expect(session.prompt.text).toBe('Review this')
    // The file that landed comes back. A pasted image whose upload failed has no
    // Retry, so its own toast reports it and it does not come back.
    expect(session.prompt.attachments.map((attachment) => attachment.id)).toEqual([doneFile.id])
  })

  test('a queued prompt whose upload fails leaves the queue and comes back to the composer', async () => {
    const { session, turns, send } = harness({ status: 'running' })
    const file = uploadingFile()
    session.prompt.attachments.push(file.chip)
    send('Next step')
    expect(session.outboundPrompts).toHaveLength(1)

    toastErrors.length = 0
    await file.fail()
    await settle()
    expect(turns).toEqual([])
    expect(session.outboundPrompts).toEqual([])
    expect(session.prompt.text).toBe('Next step')
    expect(toastErrors.some((message) => message.includes('offline'))).toBe(true)
  })

  test('text the user typed after the send is not overwritten when the prompt comes back', async () => {
    const { session, send } = harness()
    const file = uploadingFile()
    session.prompt.attachments.push(file.chip)
    send('Review this')
    session.prompt.text = 'Something new'

    await file.fail()
    await settle()
    expect(session.prompt.text).toBe('Something new')
  })

  test('a failed upload still blocks Send until it is retried or removed', () => {
    const chip = fileChip()
    // A streamed upload records its failure for the chip's Retry.
    const states = (attachmentUploads as unknown as { states: Map<string, unknown> }).states
    states.set(chip.id, { status: 'failed', message: 'offline' })
    expect(attachmentUploads.sendBlocker([chip])).toBe('Retry or remove the failed upload.')
    attachmentUploads.cancel(chip.id)
    expect(attachmentUploads.sendBlocker([chip])).toBeNull()
  })
})
