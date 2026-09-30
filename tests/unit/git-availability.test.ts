import { afterEach, describe, expect, test } from 'bun:test'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { probeGit } from '@solus/server/git/git-availability'
import { buildPackageInstallCommand } from '@solus/server/transport/handlers/setup-commands'

/**
 * A Mac without Apple's developer tools still has /usr/bin/git: a stub that
 * fails and asks macOS to open the "Install developer tools" dialog. Solus ran
 * it on every project refresh, so a user who never asked for git saw that
 * dialog again and again. Finding out whether git works must not run the stub.
 */
describe('probeGit', () => {
  const dirs: string[] = []
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  })

  function folderWithGit(): string {
    const dir = mkdtempSync(join(tmpdir(), 'solus-git-probe-'))
    dirs.push(dir)
    mkdirSync(join(dir, 'usr', 'bin'), { recursive: true })
    const git = join(dir, 'usr', 'bin', 'git')
    writeFileSync(git, '#!/bin/sh\n')
    chmodSync(git, 0o755)
    return dir
  }

  test('no git on the PATH is unusable on every platform', () => {
    const empty = mkdtempSync(join(tmpdir(), 'solus-git-probe-'))
    dirs.push(empty)
    expect(probeGit('linux', empty)).toBe(false)
    expect(probeGit('darwin', empty, () => { throw new Error('the Mac check must not run') })).toBe(false)
  })

  // The stub path is fixed, so this needs a host that has a /usr/bin/git.
  test.if(existsSync('/usr/bin/git'))('a macOS stub counts only when the developer tools behind it have git', () => {
    const developerTools = folderWithGit()
    expect(probeGit('darwin', '/usr/bin', () => developerTools)).toBe(true)
    expect(probeGit('darwin', '/usr/bin', () => null)).toBe(false)
    const emptyTools = mkdtempSync(join(tmpdir(), 'solus-git-probe-'))
    dirs.push(emptyTools)
    expect(probeGit('darwin', '/usr/bin', () => emptyTools)).toBe(false)
  })

  test('a git outside the macOS stub is usable without asking the Mac', () => {
    const dir = folderWithGit()
    const bin = join(dir, 'usr', 'bin')
    expect(probeGit('linux', bin)).toBe(true)
    expect(probeGit('darwin', bin, () => { throw new Error('the Mac check must not run') })).toBe(true)
  })
})

/**
 * The install offer must match the host's operating system. A non-technical
 * Mac user needs one button that opens Apple's installer, not a Homebrew
 * command whose git the Apple stub would still hide.
 */
describe('buildPackageInstallCommand for git', () => {
  test('a Mac gets Apple’s developer tools, even with Homebrew installed', () => {
    const spec = buildPackageInstallCommand('git', { platform: 'darwin', hasCommand: () => true })
    expect(spec).toMatchObject({
      command: 'xcode-select',
      args: ['--install'],
      autoRunnable: true,
      label: 'Install Apple developer tools',
    })
    expect(spec?.followUp).toContain('re-check')
  })

  test('Linux keeps its package manager and says nothing about Apple', () => {
    const spec = buildPackageInstallCommand('git', {
      platform: 'linux',
      hasCommand: (command) => command === 'apt-get',
      isRoot: true,
    })
    expect(spec?.command).not.toBe('xcode-select')
    expect(spec?.label).toBeUndefined()
    expect(spec?.followUp).toBeUndefined()
  })

  test('a Mac without Homebrew has no installer for gh', () => {
    expect(buildPackageInstallCommand('gh', { platform: 'darwin', hasCommand: () => false })).toBeNull()
  })
})
