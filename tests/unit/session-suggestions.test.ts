import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SUGGESTIONS_WAITING_MAX, suggestionPrompt } from '@solus/contracts/session-suggestions'
import { uploadFolderName } from '@solus/server/data/assets/attachment-store'
import { SessionSuggestions } from '@solus/server/sharing/session-suggestions'

// docs/plans/custom-roles.md §7: a guest who may only propose writes a suggestion;
// someone who may prompt sends it as their own turn or dismisses it.

let dir: string
let changed: string[]
const GUEST = { key: 'user:g1', name: 'Maya', isGuest: true }

function store() {
  return new SessionSuggestions({ attachmentsDir: dir, onChanged: (sessionId) => changed.push(sessionId), now: () => 5 })
}

/** A file as `attachUpload` would have stored it for the session. */
function uploaded(sessionId: string, name: string): string {
  const folder = join(dir, uploadFolderName(sessionId))
  mkdirSync(folder, { recursive: true })
  const path = join(folder, name)
  writeFileSync(path, 'x')
  return path
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'solus-suggestions-'))
  changed = []
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('session suggestions', () => {
  test('a guest sees only its own; someone who may prompt sees all, and each change tells the session', async () => {
    // WHY: a guest must not read what another guest proposed; the people who decide must see every one.
    const suggestions = store()
    await suggestions.suggest('s1', GUEST, { text: 'try the other fix' })
    await suggestions.suggest('s1', { key: 'user:g2', name: 'Noor', isGuest: true }, { text: 'add a test' })
    expect(suggestions.list('s1', { key: 'user:g1', seesAll: false }).map((item) => item.text)).toEqual(['try the other fix'])
    expect(suggestions.list('s1', { key: 'user:alice', seesAll: true }).map((item) => [item.text, item.isMine])).toEqual([['try the other fix', false], ['add a test', false]])
    expect(changed).toEqual(['s1', 's1'])
  })

  test('send happens once, and a failed send waits again', () => {
    // WHY: two people pressing Send must not run the turn twice; a host error must not lose the message.
    const suggestions = store()
    return suggestions.suggest('s1', GUEST, { text: 'hello' }).then((made) => {
      expect(suggestions.take('s1', made.id, 'Alice')).toEqual({ text: 'hello', attachments: [], authorName: 'Maya' })
      expect(suggestions.take('s1', made.id, 'Bob')).toBeNull()
      suggestions.restore('s1', made.id)
      expect(suggestions.list('s1', { key: 'user:g1', seesAll: false })[0]?.state).toBe('waiting')
    })
  })

  test('a guest may have only a few waiting, and only its author withdraws one', async () => {
    const suggestions = store()
    const first = await suggestions.suggest('s1', GUEST, { text: '1' })
    for (let index = 1; index < SUGGESTIONS_WAITING_MAX; index++) await suggestions.suggest('s1', GUEST, { text: String(index + 1) })
    await expect(suggestions.suggest('s1', GUEST, { text: 'one more' })).rejects.toThrow(/waiting/)
    expect(await suggestions.withdraw('s1', first.id, 'user:someone-else')).toBe(false)
    expect(await suggestions.withdraw('s1', first.id, 'user:g1')).toBe(true)
    await expect(suggestions.suggest('s1', GUEST, { text: 'now it fits' })).resolves.toMatchObject({ state: 'waiting', isMine: true })
  })

  test('a suggestion attaches only files uploaded to its own session, and dismissing it removes them', async () => {
    // WHY: a sent suggestion hands its files to the agent. A path from a client is
    // untrusted: a guest must not name a file elsewhere on the host, or another session's upload.
    const suggestions = store()
    const mine = uploaded('s1', 'a.png')
    const other = uploaded('s2', 'b.png')
    await expect(suggestions.suggest('s1', GUEST, { text: 'x', attachments: [{ name: 'b.png', mimeType: 'image/png', hostPath: other }] })).rejects.toThrow(/only files uploaded/)
    await expect(suggestions.suggest('s1', GUEST, { text: 'x', attachments: [{ name: 'p', mimeType: 'text/plain', hostPath: '/etc/passwd' }] })).rejects.toThrow(/only files uploaded/)
    await expect(suggestions.suggest('s1', GUEST, { text: 'x', attachments: [{ name: 'a', mimeType: 'image/png', hostPath: `${join(dir, uploadFolderName('s1'))}/../${uploadFolderName('s2')}/b.png` }] })).rejects.toThrow(/only files uploaded/)
    const made = await suggestions.suggest('s1', GUEST, { text: 'x', attachments: [{ name: 'a.png', mimeType: 'image/png', hostPath: mine }] })
    expect(await suggestions.dismiss('s1', made.id, 'Alice')).toBe(true)
    expect(existsSync(mine)).toBe(false)
    expect(suggestions.list('s1', { key: 'user:g1', seesAll: false })[0]).toMatchObject({ state: 'dismissed', decidedByName: 'Alice' })
  })

  test('closing the link ends what its guests suggested and nobody sent', async () => {
    const suggestions = store()
    await suggestions.suggest('s1', GUEST, { text: 'from a guest' })
    await suggestions.suggest('s1', { key: 'user:bob', name: 'Bob', isGuest: false }, { text: 'from a member' })
    await suggestions.endGuestSuggestions('s1')
    expect(suggestions.list('s1', { key: null, seesAll: true }).map((item) => [item.text, item.state])).toEqual([['from a guest', 'dismissed'], ['from a member', 'waiting']])
  })

  test('a sent suggestion says who wrote it and who sent it, so its text can never start a slash command', () => {
    // WHY: the agent must not take a guest's words as the owner's, and `/logout` from a guest must stay text.
    const prompt = suggestionPrompt('/logout', 'Maya', 'Alice')
    expect(prompt.startsWith('Message from guest Maya, sent by Alice:')).toBe(true)
    expect(prompt.startsWith('/')).toBe(false)
  })
})
