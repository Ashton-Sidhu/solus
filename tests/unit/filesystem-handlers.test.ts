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
    const { DatabaseSync } = await import('./helpers/bun-sqlite')
    mock.module('node:sqlite', () => ({ DatabaseSync }))
    const { registerFilesystemHandlers } = await import('@solus/server/transport/handlers/filesystem-handlers')
    const registered: string[] = []
    registerFilesystemHandlers({ register: (name: string) => registered.push(name) } as never)
    expect(registered).toEqual(expect.arrayContaining([
      'listProjectFiles', 'readProjectFile', 'writeFile', 'searchFiles', 'searchProjectContents',
    ]))
  })
})

describe('file search for an @ mention', () => {
  test('names a project file relative to the project, so the mention resolves in the session checkout', async () => {
    // WHY: on Windows the display path kept the main checkout's absolute path
    // (`C:\repo\README.md`), because the prefix to remove was `C:\repo/`. A
    // mention picked before a worktree existed then sent the agent's edit to
    // the main checkout, and the worktree's diff stayed empty.
    const { DatabaseSync } = await import('./helpers/bun-sqlite')
    mock.module('node:sqlite', () => ({ DatabaseSync }))
    const { mkdtempSync, realpathSync, rmSync, writeFileSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const { registerFilesystemHandlers } = await import('@solus/server/transport/handlers/filesystem-handlers')
    const { INTERNAL_PRINCIPAL } = await import('@solus/server/admission/principal')
    const handlers = new Map<string, (args: unknown[], ctx: unknown) => Promise<{ files: { path: string; display: string }[] }>>()
    registerFilesystemHandlers({ register: (name: string, handler: never) => handlers.set(name, handler) } as never)
    const project = realpathSync(mkdtempSync(join(tmpdir(), 'solus-search-display-')))
    try {
      writeFileSync(join(project, 'README.md'), 'hi')
      const result = await handlers.get('searchFiles')!(['README', project], { principal: INTERNAL_PRINCIPAL })
      const readme = result.files.find((file) => file.path === join(project, 'README.md'))
      expect(readme?.display).toBe('README.md')
    } finally {
      rmSync(project, { recursive: true, force: true })
    }
  })
})
