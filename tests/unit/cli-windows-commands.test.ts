import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { browserOpenCommand } from '../../apps/cli/src/lib/connect'
import { providerLoginCommand } from '../../apps/cli/src/lib/provider-login'
import { renameRetrying } from '../../apps/cli/src/lib/rename-retry'
import { windowsSystemTool } from '../../apps/cli/src/lib/runtime'
import { extractCommand, serverArchiveName } from '../../apps/cli/src/lib/server-release'
import { syncDirectory, syncFile } from '../../apps/cli/src/lib/update-data'

// The `solus` command on Windows (docs/plans/windows.md §7.2). Each program it
// starts is chosen by platform; these tests pin the Windows choice and keep the
// POSIX one, without running any of them.

describe('server release on Windows', () => {
  test('Windows asks for the zip, and Windows on ARM is refused with the reason', () => {
    // WHY: the Windows package is a .zip (§10 decision 2); there is no ARM64 build (§6).
    expect(serverArchiveName('win32', 'x64')).toBe('solus-server-win32-x64.zip')
    expect(serverArchiveName('linux', 'arm64')).toBe('solus-server-linux-arm64.tar.gz')
    expect(() => serverArchiveName('win32', 'arm64')).toThrow('Only x64 Windows')
  })

  test('Windows extracts with the System32 tar, never a tar found on PATH', () => {
    // WHY: an MSYS or Git tar earlier on PATH cannot read a zip.
    expect(extractCommand('a.zip', 'out', 'win32')).toEqual([windowsSystemTool('tar.exe'), ['-xf', 'a.zip', '-C', 'out']])
    expect(windowsSystemTool('tar.exe', 'C:\\Windows')).toBe('C:\\Windows\\System32\\tar.exe')
    expect(extractCommand('a.tar.gz', 'out', 'linux')).toEqual(['tar', ['-xzf', 'a.tar.gz', '-C', 'out']])
  })
})

describe('opening the sign-in page', () => {
  test('Windows passes the URL to rundll32 as one argument, not through cmd start', () => {
    // WHY: cmd reads `&` in a query string as a new command.
    const url = 'https://app.solus.sh/device?user_code=ABCD&x=1'
    expect(browserOpenCommand(url, 'win32')).toEqual([windowsSystemTool('rundll32.exe'), ['url.dll,FileProtocolHandler', url]])
    expect(browserOpenCommand(url, 'darwin')).toEqual(['open', [url]])
    expect(browserOpenCommand(url, 'linux')).toEqual(['xdg-open', [url]])
  })

  test('a URL that is not http(s) is never opened', () => {
    // WHY: the Windows handler opens any path or program it is given.
    expect(browserOpenCommand('file:///C:/Windows/System32/calc.exe', 'win32')).toBeNull()
  })
})

describe('provider sign-in', () => {
  test('Windows starts the sign-in through cmd.exe so an npm .cmd shim works', () => {
    // WHY: Node does not start `claude.cmd` without a shell, and an npm install gives only that.
    expect(providerLoginCommand('claude-code', 'win32')).toEqual({ file: windowsSystemTool('cmd.exe'), args: ['/d', '/s', '/c', 'claude auth login'], display: 'claude auth login' })
    expect(providerLoginCommand('codex', 'win32').args).toEqual(['/d', '/s', '/c', 'codex login --device-auth'])
    expect(providerLoginCommand('codex', 'linux')).toEqual({ file: 'codex', args: ['login', '--device-auth'], display: 'codex login --device-auth' })
  })
})

describe('durable writes on Windows', () => {
  const directories: string[] = []
  afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }) })

  function busy(code: string, failures: number): { rename: (from: string, to: string) => void; attempts: () => number } {
    let attempts = 0
    return {
      rename: () => {
        attempts++
        if (attempts <= failures) throw Object.assign(new Error(code), { code })
      },
      attempts: () => attempts,
    }
  }

  test('a rename that a scanner holds for a moment is retried on Windows only', () => {
    // WHY: antivirus or the indexer can hold a new file open; the update must not fail for that.
    const windows = busy('EBUSY', 2)
    renameRetrying('a', 'b', 'win32', windows.rename)
    expect(windows.attempts()).toBe(3)

    const linux = busy('EBUSY', 1)
    expect(() => renameRetrying('a', 'b', 'linux', linux.rename)).toThrow('EBUSY')
    expect(linux.attempts()).toBe(1)

    const missing = busy('ENOENT', 1)
    expect(() => renameRetrying('a', 'b', 'win32', missing.rename)).toThrow('ENOENT')
    expect(missing.attempts()).toBe(1)
  })

  test('a directory is not opened for fsync on Windows, and a file still is', () => {
    // WHY: Windows refuses to open a directory for fsync (EPERM); NTFS journals the rename.
    const directory = mkdtempSync(join(tmpdir(), 'solus-cli-sync-'))
    directories.push(directory)
    expect(() => syncDirectory(join(directory, 'missing'), 'win32')).not.toThrow()
    expect(() => syncDirectory(join(directory, 'missing'), 'linux')).toThrow()
    const file = join(directory, 'receipt.json')
    writeFileSync(file, '{}')
    expect(() => syncFile(file, 'win32')).not.toThrow()
    expect(() => syncFile(join(directory, 'missing.json'), 'win32')).toThrow()
  })
})
