import { expect, test } from 'bun:test'
import { SvelteRunes } from './helpers/svelte-runes'

test('the composer keeps its draft and attachments until the stash writes successfully', async () => {
  const runes = new SvelteRunes()
  try {
    const dependencies = runes.module('dependencies', `
      export const notices = []
      export const toasts = {
        info: (message, options) => notices.push({ message, options }),
        error: (message) => notices.push({ message }),
        success: (message) => notices.push({ message }),
      }
      export const accountStore = { hasAnswered: true, state: { kind: 'signed-out' } }
      export const attachmentUploads = {
        isPreparing: () => false, isUploading: () => false, sendBlocker: () => null,
      }
      export const serverConnections = {}
      export const uuid = () => 'new'
    `)
    const stashModel = SvelteRunes.file('packages/workspace-ui/src/components/input/lib/prompt-stash.ts')
    const composer = runes.source('composer', 'packages/workspace-ui/src/components/input/lib/prompt-stash.store.svelte.ts', {
      'svelte/reactivity': import.meta.resolve('svelte/reactivity'),
      '@solus/client-core/server-connections': dependencies,
      '@solus/contracts/uuid': dependencies,
      '../../../lib/toasts': dependencies,
      '../../../contexts/account/account.store.svelte': dependencies,
      './attachment-uploads.svelte': dependencies,
      './prompt-stash': stashModel,
    })
    const checks = runes.module('checks', `
      import assert from 'node:assert/strict'
      import { flushSync } from 'svelte'
      import { usePromptStash } from ${JSON.stringify(composer)}
      import { notices } from ${JSON.stringify(dependencies)}
      import { PromptStash, promptStashKey } from ${JSON.stringify(stashModel)}

      globalThis.window = new EventTarget()
      const values = new Map()
      let failWrites = false
      globalThis.localStorage = {
        getItem: (key) => values.get(key) ?? null,
        setItem: (key, value) => {
          if (failWrites) throw new DOMException('Storage quota exceeded', 'QuotaExceededError')
          values.set(key, value)
        },
      }
      const key = promptStashKey(null, null)
      const storage = new PromptStash(localStorage)
      const prompt = {
        text: 'Keep this draft',
        attachments: [{ id: 'file', type: 'file', name: 'notes.txt', path: '/uploads/notes.txt' }],
        planRefs: [], workRefs: [], sessionRefs: [],
      }
      const originalDraft = structuredClone(prompt)
      const saved = Array.from({ length: 100 }, (_, index) => ({
        id: String(index), createdAt: 1, serverId: 'host', sessionId: 'session', prompt,
      }))
      localStorage.setItem(key, JSON.stringify(saved))
      const editorUpdates = []
      const stop = $effect.root(() => {
        const stash = usePromptStash({
          target: () => ({ key, prompt, serverId: 'host', ctx: { session: { sessionId: 'session' } } }),
          tabId: () => 'tab',
          ownsShortcuts: () => true,
          canStash: () => true,
          updateEditor: (text) => editorUpdates.push(text),
        })
        stash.shortcut()
        assert.deepEqual(storage.read(key), saved)
        assert.deepEqual(prompt, originalDraft)
        assert.deepEqual(editorUpdates, [])
        assert.match(notices.at(-1).options.description, /Restore or delete/)
        notices.at(-1).options.action.onAction()
        assert.equal(stash.open, true)

        stash.remove(stash.entries[0])
        failWrites = true
        stash.shortcut()
        assert.deepEqual(storage.read(key), saved.slice(1))
        assert.deepEqual(prompt, originalDraft)
        assert.deepEqual(editorUpdates, [])
        assert.match(notices.at(-1).message, /still in the composer/)

        failWrites = false
        stash.shortcut()
        assert.deepEqual(storage.read(key)[0].prompt, originalDraft)
        assert.deepEqual(prompt.attachments, [])
        assert.deepEqual(editorUpdates, [''])
      })
      flushSync()
      stop()
    `)
    const child = Bun.spawn([process.execPath, checks], { stderr: 'pipe' })
    const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()])
    expect({ code, stderr }).toEqual({ code: 0, stderr: '' })
  } finally {
    runes.dispose()
  }
})
