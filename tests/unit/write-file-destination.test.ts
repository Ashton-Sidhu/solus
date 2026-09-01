import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { mkdtemp, mkdir, readFile, realpath, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { Database } from 'bun:sqlite'
import type { IpcContext, WriteFileRequest, WriteFileResult } from '@solus/contracts/types'

mock.module('electron', () => ({
  app: { isPackaged: false, getPath: () => tmpdir() },
  dialog: {},
  shell: {},
  utilityProcess: { fork: () => ({ on() {}, postMessage() {}, kill() {} }) },
}))

// bun has no node:sqlite; the handler module's import chain reaches the db even
// though these tests never open it.
mock.module('node:sqlite', () => ({ DatabaseSync: Database }))

const { registerFileHandlers } = await import('@solus/desktop-main/server/handlers/file-handlers')

/**
 * The picker lets a user browse anywhere, so the write behind it has to be able
 * to land anywhere — while an editor saving a file it opened from the project
 * tree must still be confined to that tree. Both behaviours ride the same RPC,
 * separated only by `destination`, which is exactly why they are pinned here.
 */
describe('writeFile destinations', () => {
  let sandbox = ''
  let projectRoot = ''
  let outside = ''
  let ctx: IpcContext
  let writeFile: (args: [IpcContext, WriteFileRequest]) => Promise<WriteFileResult>

  beforeEach(async () => {
    // realpath: macOS's tmpdir is a symlink, and the handler resolves before writing.
    sandbox = await realpath(await mkdtemp(join(tmpdir(), 'solus-write-file-')))
    projectRoot = join(sandbox, 'project')
    outside = join(sandbox, 'Desktop')
    await mkdir(projectRoot)
    await mkdir(outside)

    ctx = {
      session: {
        sessionId: 'session-write-file',
        workingDirectory: projectRoot,
        projectPath: projectRoot,
      },
    } as IpcContext

    const handlers = new Map<string, unknown>()
    registerFileHandlers(
      { register: (name: string, handler: unknown) => handlers.set(name, handler) } as never,
      {
        getActiveWindow: () => null,
        hideAppWindow: () => {},
        showAndFocusActiveWindow: () => {},
        setActiveWindowOpacity: () => {},
        expandDesignModeWindow: () => {},
        restoreDesignModeWindow: () => {},
        exitDesignModeWindow: () => {},
        bumpScreenshotCounter: () => 1,
        bumpDesignModeCounter: () => 1,
        bumpPasteCounter: () => 1,
        designModeCaptureRegion: () => ({ x: 0, y: 0, width: 0, height: 0 }),
      },
    )
    writeFile = handlers.get('writeFile') as typeof writeFile
  })

  afterEach(async () => {
    if (sandbox) await rm(sandbox, { recursive: true, force: true })
  })

  test('a project write still cannot escape the project root', async () => {
    const result = await writeFile([
      ctx,
      { path: join(outside, 'leaked.md'), contents: 'nope', cwd: projectRoot },
    ])

    expect(result.ok).toBe(false)
    expect(result.ok === false && result.error).toContain('outside the project directory')
  })

  test('a host write lands where the user pointed the picker', async () => {
    const target = join(outside, 'diagram.json')

    const result = await writeFile([
      ctx,
      { path: target, contents: '{"nodes":[]}', destination: 'host' },
    ])

    expect(result.ok).toBe(true)
    expect(await readFile(target, 'utf8')).toBe('{"nodes":[]}')
    // No project to be relative to, so it reports the absolute landing spot.
    expect(result.ok === true && result.displayPath).toBe(target)
  })

  test('a base64 write stores the decoded bytes, not the encoding of them', async () => {
    const target = join(outside, 'diagram.png')
    // The 8-byte PNG signature — binary that no UTF-8 round trip survives.
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

    const result = await writeFile([
      ctx,
      { path: target, contents: bytes.toString('base64'), encoding: 'base64', destination: 'host' },
    ])

    expect(result.ok).toBe(true)
    expect(await readFile(target)).toEqual(bytes)
    expect(result.ok === true && result.size).toBe(bytes.byteLength)
  })

  test('a host write still reaches a path written with ~', async () => {
    const result = await writeFile([ctx, { path: '~', contents: '', destination: 'host' }])

    // `~` is a directory, so the write fails — but on EISDIR, which proves the
    // alias was expanded on the host rather than taken as a literal name.
    expect(result.ok).toBe(false)
    expect(result.path).not.toContain('~')
  })
})
