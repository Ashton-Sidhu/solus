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

  test.each([
    ['PNG', 'image/png'], ['jpg', 'image/jpeg'], ['jpeg', 'image/jpeg'],
    ['gif', 'image/gif'], ['webp', 'image/webp'], ['svg', 'image/svg+xml'],
  ])('transports %s images as read-only data URLs instead of text', async (extension, mimeType) => {
    const bytes = Buffer.from([137, 80, 78, 71, 0, 255])
    const path = join(projectRoot, `image.${extension}`)
    await writeFile(path, bytes)
    const result = await readFilePreview(ctx, { path })
    expect(result).toMatchObject({
      ok: true,
      contents: '',
      imageDataUrl: `data:${mimeType};base64,${bytes.toString('base64')}`,
      mimeType,
      isReadOnly: true,
      size: bytes.length,
    })
  })

  test('previews external PNG screenshots over the same transport', async () => {
    const path = join(externalRoot, 'desktop.png')
    const bytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64')
    await writeFile(path, bytes)
    expect(await readFilePreview(ctx, { path })).toMatchObject({
      ok: true,
      displayPath: await realpath(path),
      imageDataUrl: `data:image/png;base64,${bytes.toString('base64')}`,
      isReadOnly: true,
    })
  })

  test('rejects oversized images without returning a partial image', async () => {
    const path = join(projectRoot, 'large.png')
    await writeFile(path, Buffer.alloc(10 * 1024 * 1024 + 1))
    expect(await readFilePreview(ctx, { path })).toMatchObject({
      ok: false, error: 'Image exceeds the 10 MB preview limit.',
    })
  })

  test('continues to reject unsupported binary files', async () => {
    const path = join(projectRoot, 'data.bin')
    await writeFile(path, Buffer.from([1, 0, 2]))
    expect(await readFilePreview(ctx, { path })).toMatchObject({
      ok: false, error: 'Binary files cannot be previewed.',
    })
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
