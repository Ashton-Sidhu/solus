import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { readLocalHostEnabled, writeLocalHostEnabled } from '../../apps/desktop/src/main/local-host-setting'

// docs/plans/desktop-remote-only.md. WHY: main reads this before it loads any server
// code, and the answer decides whether this computer listens on the network.
describe('the local host setting', () => {
  let dir: string
  let path: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'solus-local-host-'))
    path = join(dir, 'local-host.json')
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  test('a computer that never chose runs its local host', () => {
    expect(readLocalHostEnabled(path)).toBe(true)
  })

  test('the choice survives a relaunch in both directions', () => {
    writeLocalHostEnabled(path, false)
    expect(readLocalHostEnabled(path)).toBe(false)
    writeLocalHostEnabled(path, true)
    expect(readLocalHostEnabled(path)).toBe(true)
  })

  test('a damaged file never starts a server the person turned off', () => {
    writeFileSync(path, '{"enabled":')
    expect(readLocalHostEnabled(path)).toBe(false)
    writeFileSync(path, '{"enabled":"yes"}')
    expect(readLocalHostEnabled(path)).toBe(false)
  })

  test('only the owner can read or change the file', () => {
    writeLocalHostEnabled(path, false)
    expect(statSync(path).mode & 0o777).toBe(0o600)
  })
})
