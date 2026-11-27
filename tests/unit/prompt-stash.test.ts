import { describe, expect, test } from 'bun:test'
import type { Prompt } from '@solus/contracts/types'
import {
  MAX_STASHED_PROMPTS, PromptStash, STASH_FILE_LIFETIME_MS, promptStashKey,
  restoreStashedPrompt, stashAttachmentHost, stashPreview, stashedFileExpired, type PromptStashEntry,
} from '../../packages/workspace-ui/src/components/input/lib/prompt-stash'

const empty = (): Prompt => ({ text: '', attachments: [], planRefs: [], workRefs: [], sessionRefs: [] })
const entry = (id: string): PromptStashEntry => ({
  id, createdAt: 1, serverId: 'remote', sessionId: 'session',
  prompt: {
    ...empty(),
    text: 'Read the attached file.',
    attachments: [{ id: 'file', type: 'file', name: 'notes.txt', path: '/uploads/notes.txt', hostPath: '/uploads/notes.txt' }],
    workRefs: [{ workId: 'work', title: 'Notes', type: 'doc' }],
  },
})

function storageFixture() {
  const values = new Map<string, string>()
  return {
    failWrites: false,
    getItem: (key: string) => values.get(key) ?? null,
    setItem(key: string, value: string) {
      if (this.failWrites) throw new Error('Quota exceeded')
      values.set(key, value)
    },
  }
}

describe('Prompt Stash', () => {
  const key = promptStashKey('account', 'organization')

  test('keeps all 100 saved drafts when another composer fills the stash', () => {
    const storage = storageFixture()
    const stash = new PromptStash(storage)
    expect(MAX_STASHED_PROMPTS).toBe(100)
    const saved = Array.from({ length: 100 }, (_, index) => entry(`${index}`))
    for (const draft of saved.slice(0, -1)) stash.save(key, draft)
    const reopened = new PromptStash(storage)
    expect(reopened.save(key, saved[99]).status).toBe('saved')
    const expected = saved.toReversed()
    storage.failWrites = true
    expect(stash.save(key, entry('overflow'))).toEqual({ status: 'full', entries: expected })
    expect(reopened.read(key)).toEqual(expected)
    expect(reopened.read(promptStashKey('another account', 'organization'))).toEqual([])
    expect(reopened.read(promptStashKey('account', 'another organization'))).toEqual([])

    storage.failWrites = false
    expect(stash.take(key, '0').entry).toEqual(saved[0])
    expect(reopened.save(key, entry('overflow')).status).toBe('saved')
    expect(stash.read(key)).toEqual([entry('overflow'), ...expected.slice(0, -1)])
  })

  test('keeps the stored data when it cannot read the existing stash', () => {
    const storage = storageFixture()
    storage.setItem(key, '{')
    const stash = new PromptStash(storage)
    expect(() => stash.save(key, entry('new'))).toThrow()
    expect(storage.getItem(key)).toBe('{')
  })

  test('reads the latest entries before each write and removes an entry only after a successful write', () => {
    const storage = storageFixture()
    const first = new PromptStash(storage)
    const second = new PromptStash(storage)
    first.save(key, entry('first'))
    second.save(key, entry('second'))
    storage.failWrites = true
    expect(() => first.save(key, entry('third'))).toThrow()
    expect(() => first.take(key, 'first')).toThrow()
    expect(first.read(key).map((entry) => entry.id)).toEqual(['second', 'first'])
    storage.failWrites = false
    expect(first.take(key, 'first').entry).toEqual(entry('first'))
    expect(second.take(key, 'first').entry).toBeUndefined()
    expect(second.read(key).map((entry) => entry.id)).toEqual(['second'])
  })

  test('the saved prompt is independent of the composer after it clears', () => {
    const storage = storageFixture()
    const stash = new PromptStash(storage)
    const current = entry('current')
    const { entries: visibleEntries } = stash.save(key, current)
    current.prompt.text = ''
    current.prompt.attachments.splice(0)
    current.prompt.workRefs.splice(0)
    expect(visibleEntries[0]).toEqual(entry('current'))
    expect(stash.read(key)[0]).toEqual(entry('current'))
  })

  test('appends a restored draft and keeps existing copies of its attachments and references', () => {
    const target = empty()
    target.text = 'Keep this draft.  '
    target.attachments.push({ ...entry('1').prompt.attachments[0], name: 'renamed.txt' })
    restoreStashedPrompt(target, entry('1').prompt)
    expect(target.text).toBe('Keep this draft.\n\nRead the attached file.')
    expect(target.attachments.map((attachment) => attachment.name)).toEqual(['renamed.txt'])
    expect(target.workRefs).toEqual(entry('1').prompt.workRefs)
  })

  test('previews identify attachment-only prompts and truncate without splitting an emoji', () => {
    const { prompt } = entry('preview')
    expect(stashPreview({ ...prompt, text: ' ' })).toBe('(1 file)')
    expect(stashPreview({ ...prompt, text: 'First line\n\nSecond line' })).toBe('First line Second line')
    expect(stashPreview({ ...prompt, text: `${'a'.repeat(89)}🌿 rest` })).toBe(`${'a'.repeat(89)}…`)
  })

  test('uploaded files stay tied to their host and expire after 24 hours, while inline images travel', () => {
    const saved = entry('1')
    const file = saved.prompt.attachments[0]
    expect(stashAttachmentHost(file, saved.serverId)).toBe('remote')
    expect(stashAttachmentHost({ ...file, hostServerId: 'other' }, saved.serverId)).toBe('other')
    expect(stashedFileExpired(saved, file, STASH_FILE_LIFETIME_MS)).toBe(false)
    expect(stashedFileExpired(saved, file, STASH_FILE_LIFETIME_MS + 1)).toBe(true)
    const image = { ...file, type: 'image' as const, dataUrl: 'data:image/png;base64,AA==' }
    expect(stashAttachmentHost(image, saved.serverId)).toBeUndefined()
    expect(stashedFileExpired(saved, image, STASH_FILE_LIFETIME_MS + 1)).toBe(false)
  })
})
