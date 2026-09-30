import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test'
import type { Attachment, Prompt } from '@solus/contracts/types'

/**
 * Add files on a draft composer. The draft pane asked the shell to attach with
 * no target, and the shell's target named only started chats — so the picked
 * files, and the upload chip that shows their progress, landed in whichever
 * chat was active instead of the draft the user was writing.
 */

mock.module('@solus/workspace-ui/lib/analytics', () => ({
  identifyInstallation: () => {},
  initAnalytics: () => {},
  registerSuperProps: () => {},
  setAnalyticsEnabled: () => {},
  track: () => {},
}))

mock.module('svelte-sonner', () => ({ toast: Object.assign(() => '', { success: () => '', error: () => '', dismiss: () => {} }) }))

interface AttachTargetContext {
  currentInput: Prompt
  sessionFor(sourceId: string): { prompt: Prompt } | undefined
  drafts: { sessionDrafts: Map<string, { prompt: Prompt }> }
  inputFor(sourceId: string): Prompt
}

let addAttachments: (this: AttachTargetContext, attachments: Attachment[], sourceId?: string) => void
let inputFor: (this: AttachTargetContext, sourceId: string) => Prompt

const previousAudio = globalThis.Audio
const previousCustomEvent = globalThis.CustomEvent
const previousDocument = globalThis.document
const previousDerived = (globalThis as unknown as { $derived?: unknown }).$derived
const previousEffect = (globalThis as unknown as { $effect?: unknown }).$effect
const previousLocalStorage = globalThis.localStorage
const previousState = (globalThis as unknown as { $state?: unknown }).$state
const previousWindow = globalThis.window

beforeAll(async () => {
  ;(globalThis as unknown as { $derived: unknown }).$derived = Object.assign(
    <T>(value: T) => value,
    { by: <T>(read: () => T) => read() },
  )
  ;(globalThis as unknown as { $effect: unknown }).$effect = Object.assign(
    () => {},
    { pre: () => {}, root: () => () => {} },
  )
  ;(globalThis as unknown as { $state: unknown }).$state = Object.assign(
    <T>(value: T) => value,
    { raw: <T>(value: T) => value, snapshot: <T>(value: T) => value },
  )
  Object.defineProperty(globalThis, 'Audio', {
    configurable: true,
    value: class { volume = 1 },
  })
  Object.defineProperty(globalThis, 'CustomEvent', {
    configurable: true,
    value: class { constructor(_name: string, _options?: unknown) {} },
  })
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: { getItem: () => null, removeItem: () => {}, setItem: () => {} },
  })
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: {
      addEventListener: () => {},
      documentElement: { classList: { contains: () => false, toggle: () => {} } },
      hasFocus: () => true,
      removeEventListener: () => {},
      visibilityState: 'visible',
    },
  })
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      addEventListener: () => {},
      dispatchEvent: () => true,
      matchMedia: () => ({
        addEventListener: () => {},
        matches: false,
        removeEventListener: () => {},
      }),
      removeEventListener: () => {},
    },
  })
  const { WorkspaceContext } = await import('@solus/workspace-ui/contexts/workspace/workspace.context.svelte')
  addAttachments = WorkspaceContext.prototype.addAttachments as unknown as typeof addAttachments
  inputFor = WorkspaceContext.prototype.inputFor as unknown as typeof inputFor
})

afterAll(() => {
  for (const [name, previous] of [
    ['Audio', previousAudio],
    ['CustomEvent', previousCustomEvent],
    ['document', previousDocument],
    ['localStorage', previousLocalStorage],
    ['window', previousWindow],
  ] as const) {
    if (previous === undefined) delete (globalThis as unknown as { [key: string]: unknown })[name]
    else Object.defineProperty(globalThis, name, { configurable: true, value: previous })
  }
  if (previousState === undefined) delete (globalThis as unknown as { $state?: unknown }).$state
  else (globalThis as unknown as { $state: unknown }).$state = previousState
  if (previousDerived === undefined) delete (globalThis as unknown as { $derived?: unknown }).$derived
  else (globalThis as unknown as { $derived: unknown }).$derived = previousDerived
  if (previousEffect === undefined) delete (globalThis as unknown as { $effect?: unknown }).$effect
  else (globalThis as unknown as { $effect: unknown }).$effect = previousEffect
})


function prompt(): Prompt {
  return { text: '', attachments: [], planRefs: [], workRefs: [], sessionRefs: [] }
}

const recording: Attachment = {
  id: 'recording',
  type: 'file',
  name: 'Screen Recording.mov',
  path: '/Users/me/Desktop/Screen Recording.mov',
  mimeType: 'video/quicktime',
  size: 23_491_878,
}

function workspaceWithDraft() {
  const chatPrompt = prompt()
  const draftPrompt = prompt()
  const context: AttachTargetContext = {
    currentInput: prompt(),
    sessionFor: (sourceId) => (sourceId === 'chat-tab' ? { prompt: chatPrompt } : undefined),
    drafts: { sessionDrafts: new Map([['draft-1', { prompt: draftPrompt }]]) },
    inputFor: (sourceId) => inputFor.call(context, sourceId),
  }
  return { context, chatPrompt, draftPrompt }
}

describe('files attached to a draft', () => {
  test('land in the draft prompt, not the active chat', () => {
    const { context, chatPrompt, draftPrompt } = workspaceWithDraft()
    addAttachments.call(context, [recording], 'draft-1')
    expect(draftPrompt.attachments).toEqual([recording])
    expect(chatPrompt.attachments).toEqual([])
    expect(context.currentInput.attachments).toEqual([])
  })

  test('a chat tab still gets its own session prompt', () => {
    const { context, chatPrompt, draftPrompt } = workspaceWithDraft()
    addAttachments.call(context, [recording], 'chat-tab')
    expect(chatPrompt.attachments).toEqual([recording])
    expect(draftPrompt.attachments).toEqual([])
  })
})
