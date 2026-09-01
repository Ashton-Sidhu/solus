import { describe, expect, test } from 'bun:test'
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { findOnPath } from '../../src/main/cli-env'

function pathWith(...dirs: string[]): string {
  return dirs.join(':')
}

function binDir(name: string, opts: { executable: boolean } = { executable: true }): string {
  const dir = mkdtempSync(join(tmpdir(), 'cli-path-'))
  mkdirSync(dir, { recursive: true })
  const file = join(dir, name)
  writeFileSync(file, '#!/bin/sh\n')
  chmodSync(file, opts.executable ? 0o755 : 0o644)
  return dir
}

describe('findOnPath', () => {
  test('finds an installed binary `which` failed to report', () => {
    // WHY: this is the whole point of the fallback. A `which` that answers
    // nothing marked both agents unavailable, and every agent picker in the app
    // filters to available agents — so the menus rendered empty while the
    // binaries sat on PATH the entire time.
    const dir = binDir('claude')
    expect(findOnPath('claude', pathWith('/nonexistent', dir))).toBe(join(dir, 'claude'))
  })

  test('a non-executable file of the right name is not the binary', () => {
    // WHY: reporting an unrunnable path as available moves the failure from an
    // honest "not installed" to a session that dies at spawn.
    const dir = binDir('codex', { executable: false })
    expect(findOnPath('codex', pathWith(dir))).toBeNull()
  })

  test('earlier PATH entries win', () => {
    // WHY: PATH order is how a user pins a version manager's shim ahead of a
    // system install; a scan that ignored it would launch the wrong binary.
    const first = binDir('claude')
    const second = binDir('claude')
    expect(findOnPath('claude', pathWith(first, second))).toBe(join(first, 'claude'))
  })

  test('empty PATH segments are skipped rather than resolved against the cwd', () => {
    // WHY: a trailing colon means "nothing here", not "look in the working
    // directory" — resolving it would let a repo ship its own `claude`.
    expect(findOnPath('claude', ':')).toBeNull()
  })
})
