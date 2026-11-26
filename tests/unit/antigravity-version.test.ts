import { afterEach, expect, test } from 'bun:test'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { antigravityVersion } from '@solus/server/updates/antigravity-software-adapter'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

// WHY: an agy that Solus did not install (on PATH, or an instance's binary path) gets its update
// check from its own `--version`. agy 1.5.18 answers with the bare version, `1.5.18`.
test('the version of an agy that Solus did not install is the one it prints', async () => {
  const root = mkdtempSync(join(tmpdir(), 'agy-version-'))
  roots.push(root)
  const binary = join(root, 'agy')
  writeFileSync(binary, '#!/bin/sh\n[ "$1" = "--version" ] && echo 1.5.18\n')
  chmodSync(binary, 0o755)
  expect(await antigravityVersion(binary)).toBe('1.5.18')
  expect(await antigravityVersion(join(root, 'missing'))).toBeNull()
})
