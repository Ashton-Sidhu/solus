import { afterEach, describe, expect, test } from 'bun:test'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  fileManagerArgs,
  fileManagerKindOf,
  resolveFileManagerCommand,
  type FileManagerHost,
} from '../../packages/server/src/platform/file-manager'

// The host opens a folder with the command its desktop provides, and reports
// no file manager where opening one would silently do nothing.

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** A PATH holding stub commands. */
function pathWith(commands: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'solus-file-manager-'))
  dirs.push(dir)
  for (const command of commands) {
    const file = join(dir, command)
    writeFileSync(file, '#!/bin/sh\n')
    chmodSync(file, 0o755)
  }
  return dir
}

function host(platform: NodeJS.Platform, env: NodeJS.ProcessEnv, path: string, hasDirectoryHandler = true): FileManagerHost {
  return { platform, env, path, hasDirectoryHandler: async () => hasDirectoryHandler }
}

describe('resolveFileManagerCommand', () => {
  test('macOS opens Finder with open', async () => {
    const command = await resolveFileManagerCommand(host('darwin', {}, pathWith(['open'])))
    expect(command).toBe('open')
    expect(fileManagerKindOf(command!)).toBe('finder')
  })

  test('Windows opens File Explorer', async () => {
    const command = await resolveFileManagerCommand(host('win32', {}, ''))
    expect(command).toBe('explorer')
    expect(fileManagerKindOf(command!)).toBe('file-explorer')
  })

  test('a Linux desktop with a folder handler opens it with xdg-open', async () => {
    const command = await resolveFileManagerCommand(host('linux', { DISPLAY: ':0' }, pathWith(['xdg-open'])))
    expect(command).toBe('xdg-open')
    expect(fileManagerKindOf(command!)).toBe('files')
  })

  test('a Linux desktop with no folder handler has no file manager', async () => {
    expect(await resolveFileManagerCommand(host('linux', { DISPLAY: ':0' }, pathWith(['xdg-open']), false))).toBeUndefined()
  })

  test('a headless Linux host has no file manager', async () => {
    expect(await resolveFileManagerCommand(host('linux', {}, pathWith(['xdg-open'])))).toBeUndefined()
  })

  test('WSL prefers Windows Explorer', async () => {
    const env = { WSL_DISTRO_NAME: 'Ubuntu', DISPLAY: ':0' }
    expect(await resolveFileManagerCommand(host('linux', env, pathWith(['explorer.exe', 'xdg-open'])))).toBe('explorer.exe')
  })

  test('WSL without Explorer on PATH keeps the Linux file manager', async () => {
    const env = { WSL_DISTRO_NAME: 'Ubuntu', DISPLAY: ':0' }
    expect(await resolveFileManagerCommand(host('linux', env, pathWith(['xdg-open'])))).toBe('xdg-open')
  })

  test('WSL over SSH is not the Windows desktop', async () => {
    const env = { WSL_DISTRO_NAME: 'Ubuntu', SSH_CONNECTION: '1 2 3 4' }
    expect(await resolveFileManagerCommand(host('linux', env, pathWith(['explorer.exe'])))).toBeUndefined()
  })
})

describe('fileManagerArgs', () => {
  test('Explorer reads a WSL folder through the distro share', () => {
    expect(fileManagerArgs('/home/me/app', 'explorer.exe', { WSL_DISTRO_NAME: 'Ubuntu' }))
      .toEqual(['\\\\wsl.localhost\\Ubuntu\\home\\me\\app'])
  })

  test('every other command takes the folder as it is', () => {
    expect(fileManagerArgs('/Users/me/app', 'open', {})).toEqual(['/Users/me/app'])
  })
})
