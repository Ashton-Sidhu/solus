import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveAgentOwnership } from '../../packages/server/src/server/handlers/setup-commands'

// Provider Update must reuse the installer that already owns the CLI on this
// host, and refuse to run it — rather than create a competing install —
// when something else put that CLI there
// (docs/plans/host-and-provider-updates.md).

describe('resolveAgentOwnership', () => {
  let home: string
  beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'solus-agent-ownership-')) })
  afterEach(() => { rmSync(home, { recursive: true, force: true }) })

  test('reports absent when the CLI is not on PATH', () => {
    const ownership = resolveAgentOwnership('claude', { resolveCommandPath: () => null, home })
    expect(ownership).toEqual({ kind: 'absent' })
  })

  test('a Claude binary under the native installer\'s managed directory is solus-managed', () => {
    const managedDir = join(home, '.local', 'share', 'claude', 'versions', '1.0.0')
    mkdirSync(managedDir, { recursive: true })
    const target = join(managedDir, 'claude')
    writeFileSync(target, '')
    const link = join(home, '.local', 'bin', 'claude')
    mkdirSync(join(home, '.local', 'bin'), { recursive: true })
    symlinkSync(target, link)

    const ownership = resolveAgentOwnership('claude', { resolveCommandPath: () => link, home })
    expect(ownership).toEqual({ kind: 'solus-managed', resolvedPath: link })
  })

  test('a Claude binary anywhere else is unmanaged', () => {
    const other = join(home, 'usr-local-bin', 'claude')
    mkdirSync(join(home, 'usr-local-bin'), { recursive: true })
    writeFileSync(other, '')

    const ownership = resolveAgentOwnership('claude', { resolveCommandPath: () => other, home })
    expect(ownership).toEqual({ kind: 'unmanaged', resolvedPath: other })
  })

  test('a Codex binary inside npm\'s global bin directory is solus-managed', () => {
    const npmBin = join(home, 'npm-global', 'bin')
    mkdirSync(npmBin, { recursive: true })
    const codex = join(npmBin, 'codex')
    writeFileSync(codex, '')

    const ownership = resolveAgentOwnership('codex', { resolveCommandPath: () => codex, npmGlobalBinDir: () => npmBin, home })
    expect(ownership).toEqual({ kind: 'solus-managed', resolvedPath: codex })
  })

  test('a Codex binary outside npm\'s global bin directory is unmanaged', () => {
    const brewBin = join(home, 'homebrew', 'bin')
    mkdirSync(brewBin, { recursive: true })
    const codex = join(brewBin, 'codex')
    writeFileSync(codex, '')
    const npmBin = join(home, 'npm-global', 'bin')
    mkdirSync(npmBin, { recursive: true })

    const ownership = resolveAgentOwnership('codex', { resolveCommandPath: () => codex, npmGlobalBinDir: () => npmBin, home })
    expect(ownership).toEqual({ kind: 'unmanaged', resolvedPath: codex })
  })

  test('a Codex binary is unmanaged when npm has no usable global prefix', () => {
    const other = join(home, 'somewhere', 'codex')
    mkdirSync(join(home, 'somewhere'), { recursive: true })
    writeFileSync(other, '')

    const ownership = resolveAgentOwnership('codex', { resolveCommandPath: () => other, npmGlobalBinDir: () => null, home })
    expect(ownership).toEqual({ kind: 'unmanaged', resolvedPath: other })
  })
})
