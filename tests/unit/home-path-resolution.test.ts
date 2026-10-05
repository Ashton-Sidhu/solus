import { expect, test } from 'bun:test'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { NEW_CHAT_DIRECTORY } from '@solus/contracts/chat'
import { resolveHomePath } from '@solus/server/platform/paths'

// `spawn` reads a bare `~` as a directory with that name, so every agent
// working directory is resolved first. `~` is the home folder; a chat is never
// a `~` (docs/plans/projectless-chat.md).

test('resolves a bare ~ to the home folder', () => {
  expect(resolveHomePath('~')).toBe(homedir())
})

test('expands a tilde-rooted path', () => {
  expect(resolveHomePath('~/projects/solus')).toBe(join(homedir(), 'projects/solus'))
  expect(resolveHomePath('~/')).toBe(homedir())
})

test('never passes an empty directory to spawn', () => {
  expect(resolveHomePath('')).toBe(homedir())
})

test('refuses a new chat that was not given its folder, rather than run it somewhere else', () => {
  expect(() => resolveHomePath(NEW_CHAT_DIRECTORY)).toThrow()
})

test('leaves a real path alone', () => {
  expect(resolveHomePath('/Users/someone/code')).toBe('/Users/someone/code')
})

test('only expands a leading tilde — one inside a path is a real directory name', () => {
  expect(resolveHomePath('/tmp/~backup')).toBe('/tmp/~backup')
  expect(resolveHomePath('/tmp/~/nested')).toBe('/tmp/~/nested')
})
