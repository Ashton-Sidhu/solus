import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { desktopRefusal } from '../../apps/cli/src/lib/desktop-commands'

// The `solus` command of the Windows desktop app (docs/plans/windows.md §13.5),
// shipped as VS Code ships `code`: a launcher in the app folder, and an
// installer that puts that folder on the user PATH.

const read = (path: string) => readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8')
const launcher = read('packaging/windows/bin/solus.cmd')
const pathScript = read('packaging/windows/path-entry.ps1')
const installer = read('packaging/windows/installer.nsh')
const build = JSON.parse(read('package.json')).build

describe('the launcher', () => {
  test('runs the bundled CLI through the app executable beside it, so it moves and updates with the app', () => {
    expect(launcher).toContain('set "ELECTRON_RUN_AS_NODE=1"')
    expect(launcher).toContain('set "SOLUS_DESKTOP_CLI=1"')
    expect(launcher).toContain('"%~dp0..\\Solus.exe" "%~dp0..\\resources\\app.asar\\dist\\main\\cli.js" %*')
    // WHY: the exit code is the CLI's, so a script can test it.
    expect(launcher).toContain('endlocal & exit /b %ERRORLEVEL%')
  })

  test('has CRLF line endings, which cmd.exe needs', () => {
    expect(launcher.split('\n').every((line) => line === '' || line.endsWith('\r'))).toBe(true)
  })
})

describe('the installer', () => {
  test('ships the launcher in bin beside Solus.exe and the PATH script in resources', () => {
    expect(build.win.extraFiles).toContainEqual({ from: 'packaging/windows/bin', to: 'bin' })
    expect(build.win.extraResources).toContainEqual({ from: 'packaging/windows/path-entry.ps1', to: 'path-entry.ps1' })
    expect(build.nsis.include).toBe('packaging/windows/installer.nsh')
  })

  test('install adds the bin folder; uninstall removes it, except during an update', () => {
    expect(installer).toContain('-File "$INSTDIR\\resources\\path-entry.ps1" -${ACTION} "$INSTDIR\\bin"')
    expect(installer).toMatch(/!macro customInstall\s+!insertmacro solusPathEntry Add/)
    // WHY: an update uninstalls the old version first; `solus` must not drop off the PATH.
    expect(installer).toMatch(/!macro customUnInstall\s+[^!]*\$\{ifNot\} \$\{isUpdated\}\s+!insertmacro solusPathEntry Remove/)
  })

  test('the PATH edit keeps the value kind and every other entry', () => {
    // WHY: SetEnvironmentVariable rewrites the PATH as REG_SZ, so %VAR% entries stop
    // expanding; NSIS string functions cut it at 1024 characters.
    expect(pathScript).not.toContain("SetEnvironmentVariable('Path'")
    expect(pathScript).toContain("$key.GetValue('Path', '', 'DoNotExpandEnvironmentNames')")
    expect(pathScript).toContain("$key.SetValue('Path', ($next -join ';'), $kind)")
    expect(pathScript).toContain("$ErrorActionPreference = 'Stop'")
  })
})

describe('the desktop app solus command', () => {
  test('runs pair and connect, and explains the standalone-only commands', () => {
    expect(desktopRefusal('pair')).toBeNull()
    expect(desktopRefusal('connect')).toBeNull()
    for (const command of ['setup', 'start', 'service', 'update', 'status', 'logs']) {
      expect(desktopRefusal(command)).toContain('standalone')
    }
  })
})
