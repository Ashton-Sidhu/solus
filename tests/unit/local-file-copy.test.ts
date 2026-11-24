import { expect, mock, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { readFile, rm, stat } from 'node:fs/promises'
import { basename, dirname } from 'node:path'
import { MAX_ATTACHMENT_UPLOAD_BYTES } from '@solus/contracts/rpc'

mock.module('electron', () => ({ app: {}, ipcMain: {}, shell: {} }))
const { stageAndShowLocalFileCopy } = await import('../../apps/desktop/src/main/local-file-copy')

const bytes = (text: string) => new TextEncoder().encode(text).buffer

test('copies with the same sanitized name stay separate and have no executable bit', async () => {
  const staged = new Set<string>()
  const shell = {
    openPath: async (path: string) => { staged.add(path); return '' },
    showItemInFolder: (path: string) => { staged.add(path) },
  }
  try {
    const opened = await stageAndShowLocalFileCopy('../src\\a:b.md', bytes('first copy'), 'open', shell)
    const revealed = await stageAndShowLocalFileCopy('a:b.md', bytes('second copy'), 'reveal', shell)
    expect(opened.status).toBe('done')
    expect(revealed.status).toBe('done')
    const paths = [...staged]
    expect(paths.map((path) => basename(path))).toEqual(['a_b.md', 'a_b.md'])
    expect(dirname(paths[0]!)).not.toBe(dirname(paths[1]!))
    expect(await readFile(paths[0]!, 'utf8')).toBe('first copy')
    expect(await readFile(paths[1]!, 'utf8')).toBe('second copy')
    if (process.platform !== 'win32') {
      expect((await stat(paths[0]!)).mode & 0o777).toBe(0o600)
      expect((await stat(dirname(paths[0]!))).mode & 0o777).toBe(0o700)
    }
  } finally {
    await Promise.all([...staged].map((path) => rm(dirname(path), { recursive: true, force: true })))
  }
})

test('executables, shortcuts and disguised executable bytes never reach the opener', async () => {
  const openPath = mock(async (_path: string) => '')
  const shell = { openPath, showItemInFolder: mock((_path: string) => {}) }
  for (const name of ['tool.exe', 'run.command', 'shortcut.lnk', 'run.js', 'CON.txt']) {
    expect(await stageAndShowLocalFileCopy(name, bytes('file'), 'open', shell)).toEqual({ status: 'unsafe' })
  }
  expect(await stageAndShowLocalFileCopy('code.md', bytes('#!/bin/sh\n'), 'open', shell)).toEqual({ status: 'unsafe' })
  expect(await stageAndShowLocalFileCopy('image.png', bytes('MZ code'), 'open', shell)).toEqual({ status: 'unsafe' })
  expect(await stageAndShowLocalFileCopy('large.txt', new ArrayBuffer(MAX_ATTACHMENT_UPLOAD_BYTES + 1), 'reveal', shell))
    .toEqual({ status: 'unavailable' })
  expect(openPath).not.toHaveBeenCalled()
  expect(shell.showItemInFolder).not.toHaveBeenCalled()
})

test('Reveal gives executable files an inert suffix, and a failed Open deletes its copy', async () => {
  let revealed: string | undefined
  let failed: string | undefined
  const shell = {
    openPath: async (path: string) => { failed = path; return 'No handler' },
    showItemInFolder: (path: string) => { revealed = path },
  }
  try {
    expect((await stageAndShowLocalFileCopy('stuff/launch.exe ', bytes('MZ'), 'reveal', shell)).status).toBe('done')
    expect(revealed && basename(revealed)).toBe('launch.exe.txt')
    expect(await stageAndShowLocalFileCopy('readme.txt', bytes('text'), 'open', shell)).toEqual({ status: 'unavailable' })
    expect(failed && existsSync(dirname(failed))).toBe(false)
  } finally {
    if (revealed) await rm(dirname(revealed), { recursive: true, force: true })
  }
})
