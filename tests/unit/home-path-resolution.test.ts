import { expect, test } from 'bun:test'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { resolveHomePath } from '@solus/server/platform/paths'

test('expands the sentinel the renderer sends when no directory is known', () => {
  expect(resolveHomePath('~')).toBe(homedir())
})

test('expands a tilde-rooted path', () => {
  expect(resolveHomePath('~/projects/solus')).toBe(join(homedir(), 'projects/solus'))
  expect(resolveHomePath('~/')).toBe(homedir())
})

test('treats an empty directory as unknown rather than passing it to spawn', () => {
  expect(resolveHomePath('')).toBe(homedir())
})

test('leaves a real path alone', () => {
  expect(resolveHomePath('/Users/someone/code')).toBe('/Users/someone/code')
})

test('only expands a leading tilde — one inside a path is a real directory name', () => {
  expect(resolveHomePath('/tmp/~backup')).toBe('/tmp/~backup')
  expect(resolveHomePath('/tmp/~/nested')).toBe('/tmp/~/nested')
})
