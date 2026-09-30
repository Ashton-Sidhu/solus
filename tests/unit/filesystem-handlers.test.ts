import { describe, expect, mock, test } from 'bun:test'
import { expandHome } from '@solus/server/files/host-path'

describe('filesystem handler paths', () => {
  test('expands home shorthand with the browsed host separator', () => {
    expect(expandHome('~/code', '/home/solus', 'linux')).toBe('/home/solus/code')
    expect(expandHome('~\\code', String.raw`C:\Users\solus`, 'win32')).toBe(
      String.raw`C:\Users\solus\code`,
    )
    expect(expandHome('~/code', String.raw`C:\Users\solus`, 'win32')).toBe(
      String.raw`C:\Users\solus\code`,
    )
  })

  test('does not interpret a backslash as a home separator on POSIX', () => {
    expect(expandHome('~\\code', '/home/solus', 'linux')).not.toBe('/home/solus/code')
  })
})

describe('file pane handlers on every host', () => {
  test('the shared server registers them, so a standalone host can open and save files', async () => {
    // WHY: these lived in the desktop-only handlers. A paired headless host
    // listed the tree but failed every click and every save.
    const { Database } = await import('bun:sqlite')
    mock.module('node:sqlite', () => ({ DatabaseSync: Database }))
    const { registerFilesystemHandlers } = await import('@solus/server/transport/handlers/filesystem-handlers')
    const registered: string[] = []
    registerFilesystemHandlers({ register: (name: string) => registered.push(name) } as never)
    expect(registered).toEqual(expect.arrayContaining([
      'listProjectFiles', 'readProjectFile', 'writeFile', 'searchFiles', 'searchProjectContents',
    ]))
  })
})
