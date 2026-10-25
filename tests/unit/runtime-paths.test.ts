import { afterEach, describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import { isPackagedRuntime } from '@solus/server/platform/paths'
import { defaultBinDir, defaultRuntimeDir, launcherPath, nodeBinary } from '../../apps/cli/src/lib/runtime'

const originalInstallDir = process.env.SOLUS_INSTALL_DIR

afterEach(() => {
  if (originalInstallDir === undefined) delete process.env.SOLUS_INSTALL_DIR
  else process.env.SOLUS_INSTALL_DIR = originalInstallDir
})

describe('packaged runtime detection', () => {
  test('recognizes the installed standalone server launcher', () => {
    process.env.SOLUS_INSTALL_DIR = '/opt/solus'
    expect(isPackagedRuntime()).toBe(true)
  })
})

describe('the solus command folders', () => {
  // WHY: Windows has no `~/.local/share` and starts only `.exe` and `.cmd` files.
  // The folders follow docs/plans/windows.md §5.8, and POSIX keeps its layout.
  const home = 'C:\\Users\\ada'

  test('Windows keeps versions under LOCALAPPDATA and the launcher beside Claude Code', () => {
    expect(defaultRuntimeDir({ LOCALAPPDATA: 'C:\\Users\\ada\\AppData\\Local' }, home, 'win32')).toBe('C:\\Users\\ada\\AppData\\Local\\solus\\runtime')
    expect(defaultRuntimeDir({}, home, 'win32')).toBe('C:\\Users\\ada\\AppData\\Local\\solus\\runtime')
    expect(defaultBinDir({}, home, 'win32')).toBe('C:\\Users\\ada\\.local\\bin')
    expect(launcherPath(defaultBinDir({}, home, 'win32'), 'win32')).toBe('C:\\Users\\ada\\.local\\bin\\solus.cmd')
    expect(nodeBinary('C:\\Users\\ada\\AppData\\Local\\solus\\runtime\\current', 'win32')).toBe('C:\\Users\\ada\\AppData\\Local\\solus\\runtime\\current\\bin\\node.exe')
  })

  test('POSIX folders are unchanged', () => {
    expect(defaultRuntimeDir({}, '/home/ada', 'linux')).toBe(join('/home/ada', '.local', 'share', 'solus'))
    expect(defaultBinDir({}, '/home/ada', 'darwin')).toBe(join('/home/ada', '.local', 'bin'))
    expect(launcherPath(join('/home/ada', '.local', 'bin'), 'linux')).toBe(join('/home/ada', '.local', 'bin', 'solus'))
    expect(nodeBinary(join('/opt', 'solus'), 'linux')).toBe(join('/opt', 'solus', 'bin', 'node'))
  })

  test('an explicit override wins on every platform', () => {
    expect(defaultRuntimeDir({ SOLUS_RUNTIME_DIR: 'D:\\solus' }, home, 'win32')).toBe('D:\\solus')
    expect(defaultBinDir({ SOLUS_BIN_DIR: 'D:\\bin' }, home, 'win32')).toBe('D:\\bin')
  })
})
