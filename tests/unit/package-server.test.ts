import { afterEach, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseTarget, writeLaunchers, writeSha256Sums } from '../../scripts/package-server'

const dirs: string[] = []

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'solus-package-server-'))
  dirs.push(dir)
  return dir
}

// WHY: Solus builds and tests the Windows server for x64 only
// (docs/plans/windows.md §6). An ARM64 package must fail with the limit named,
// not be built and published untested.
test('the Windows target is x64 only', () => {
  expect(parseTarget(['--platform', 'win32', '--arch', 'x64'])).toEqual({ platform: 'win32', arch: 'x64', headless: false })
  expect(parseTarget(['--headless', '--platform=win32', '--arch=amd64'])).toEqual({ platform: 'win32', arch: 'x64', headless: true })
  expect(() => parseTarget(['--platform', 'win32', '--arch', 'arm64'])).toThrow('Windows on ARM (win32-arm64) is not supported')
})

// WHY: Windows cannot run a `#!/usr/bin/env sh` launcher. The `.cmd` must call
// the bundled node.exe from its own folder, pass every argument, give back
// node's exit code, and use CRLF so cmd.exe finds the `:server` label.
test('the Windows launchers are .cmd files that run the bundled node.exe', () => {
  const staging = tempDir()
  writeLaunchers(staging, 'win32')
  const solus = readFileSync(join(staging, 'bin', 'solus.cmd'), 'utf8')
  const server = readFileSync(join(staging, 'bin', 'solus-server.cmd'), 'utf8')
  expect(existsSync(join(staging, 'bin', 'solus'))).toBe(false)

  for (const text of [solus, server]) {
    expect(text.startsWith('@echo off\r\n')).toBe(true)
    expect(text.replaceAll('\r\n', '')).not.toContain('\n')
    expect(text).not.toContain('chcp')
    expect(text).toContain('set "SOLUS_INSTALL_DIR=%%~fI"')
  }
  expect(solus).toContain('"%SOLUS_INSTALL_DIR%\\bin\\node.exe" "%SOLUS_INSTALL_DIR%\\libexec\\cli\\solus.js" %*\r\nexit /b %ERRORLEVEL%')
  // As the POSIX launcher: `auth` and `git-credential` go to the server, everything else is `solus start`.
  expect(server).toContain('if "%~1"=="auth" goto server')
  expect(server).toContain('if "%~1"=="git-credential" goto server')
  expect(server).toContain('\\libexec\\cli\\solus.js" start %*')
  expect(server).toContain(':server\r\n"%SOLUS_INSTALL_DIR%\\bin\\node.exe" "%SOLUS_INSTALL_DIR%\\libexec\\server\\standalone.js" %*')
})

// WHY: the POSIX launchers must not change when the Windows target is added.
test('the POSIX launchers stay sh scripts', () => {
  const staging = tempDir()
  writeLaunchers(staging, 'linux')
  expect(readFileSync(join(staging, 'bin', 'solus'), 'utf8')).toStartWith('#!/usr/bin/env sh\n')
  expect(existsSync(join(staging, 'bin', 'solus.cmd'))).toBe(false)
})

// WHY: install.ps1 and the updater verify the Windows zip against the same
// SHA256SUMS as the tarballs. A zip missing from it cannot be installed.
test('SHA256SUMS lists the zip and the tarballs and nothing else', () => {
  const release = tempDir()
  writeFileSync(join(release, 'solus-server-win32-x64.zip'), 'zip')
  writeFileSync(join(release, 'solus-server-linux-x64.tar.gz'), 'tar')
  writeFileSync(join(release, 'solus-server-linux-x64.tar'), 'other')
  writeFileSync(join(release, 'notes.zip'), 'other')
  writeSha256Sums(release)
  const names = readFileSync(join(release, 'SHA256SUMS'), 'utf8').trim().split('\n').map((line) => line.split('  ')[1])
  expect(names).toEqual(['solus-server-linux-x64.tar.gz', 'solus-server-win32-x64.zip'])
})
