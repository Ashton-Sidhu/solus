import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { readFilePreview } from '@solus/server/server/handlers/lib/file-preview'
import { isInsideRoot } from '@solus/server/paths'
import type { IpcContext } from '@solus/contracts/types'

describe('file preview paths', () => {
  let sandbox = ''
  let projectRoot = ''
  let externalRoot = ''
  let ctx: IpcContext

  beforeEach(async () => {
    sandbox = await mkdtemp(join(tmpdir(), 'solus-file-preview-'))
    projectRoot = join(sandbox, 'project')
    externalRoot = join(sandbox, 'Downloads')
    await mkdir(projectRoot)
    await mkdir(externalRoot)

    ctx = {
      session: {
        sessionId: 'session-file-preview',
        workingDirectory: projectRoot,
        projectPath: projectRoot,
      },
    } as IpcContext
  })

  afterEach(async () => {
    if (sandbox) await rm(sandbox, { recursive: true, force: true })
  })

  test('keeps files inside the project editable', async () => {
    const path = join(projectRoot, 'inside.ts')
    await writeFile(path, 'export const inside = true\n')
    const resolvedPath = await realpath(path)

    const result = await readFilePreview(ctx, { path: 'inside.ts' })

    expect(result).toMatchObject({
      ok: true,
      path: resolvedPath,
      displayPath: 'inside.ts',
      isReadOnly: false,
    })
  })

  test('previews files outside the project as read-only', async () => {
    const path = join(externalRoot, 'notes.txt')
    await writeFile(path, 'downloaded notes\n')
    const resolvedPath = await realpath(path)

    const result = await readFilePreview(ctx, { path })

    expect(result).toEqual({
      ok: true,
      path: resolvedPath,
      displayPath: resolvedPath,
      contents: 'downloaded notes\n',
      size: 17,
      isReadOnly: true,
      mimeType: 'text/plain',
    })
  })

  test('treats a project symlink to an external file as read-only', async () => {
    const externalPath = join(externalRoot, 'linked.txt')
    const linkedPath = join(projectRoot, 'linked.txt')
    await writeFile(externalPath, 'outside\n')
    await symlink(externalPath, linkedPath)
    const resolvedExternalPath = await realpath(externalPath)

    const preview = await readFilePreview(ctx, { path: 'linked.txt' })
    expect(preview).toMatchObject({
      ok: true,
      path: resolvedExternalPath,
      displayPath: resolvedExternalPath,
      isReadOnly: true,
    })

    expect(isInsideRoot(await realpath(projectRoot), await realpath(linkedPath))).toBe(false)
    expect(await readFile(externalPath, 'utf8')).toBe('outside\n')
  })
})
