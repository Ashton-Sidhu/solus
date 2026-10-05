import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { readFilePreview } from '@solus/server/files/file-preview'
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
    ['PNG', 'image', 'image/png'], ['jpg', 'image', 'image/jpeg'], ['gif', 'image', 'image/gif'],
    ['webp', 'image', 'image/webp'], ['avif', 'image', 'image/avif'], ['bmp', 'image', 'image/bmp'],
    ['ico', 'image', 'image/x-icon'], ['svg', 'image', 'image/svg+xml'],
    ['pdf', 'pdf', 'application/pdf'], ['mp4', 'video', 'video/mp4'], ['mov', 'video', 'video/quicktime'],
  ])('names a .%s file as %s media without sending its bytes', async (extension, kind, mime) => {
    // WHY: media loads from a signed URL. Bytes on the RPC channel would cap
    // a video or PDF at the payload limit and stall every other message.
    const bytes = Buffer.from([137, 80, 78, 71, 0, 255])
    const path = join(projectRoot, `media.${extension}`)
    await writeFile(path, bytes)
    const result = await readFilePreview(ctx, { path })
    expect(result).toEqual({
      ok: true,
      kind: 'media',
      path: await realpath(path),
      displayPath: `media.${extension}`,
      size: bytes.length,
      media: { kind, mime },
    })
  })

  test('names a large media file without a size limit', async () => {
    const path = join(externalRoot, 'recording.mp4')
    await writeFile(path, Buffer.alloc(20 * 1024 * 1024))
    expect(await readFilePreview(ctx, { path })).toMatchObject({
      ok: true, kind: 'media', displayPath: await realpath(path), size: 20 * 1024 * 1024,
    })
  })

  test('answers any other binary file with its size, never as text', async () => {
    // WHY: a PDF-like file with an unknown extension must not open in the
    // editor as garbage, and the pane needs the size for its fallback.
    const path = join(projectRoot, 'data.bin')
    await writeFile(path, Buffer.from([1, 0, 2]))
    expect(await readFilePreview(ctx, { path })).toEqual({
      ok: true, kind: 'binary', path: await realpath(path), displayPath: 'data.bin', size: 3,
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

  test('keeps files outside the project editable', async () => {
    const path = join(externalRoot, 'notes.txt')
    await writeFile(path, 'downloaded notes\n')
    const resolvedPath = await realpath(path)

    const result = await readFilePreview(ctx, { path })

    expect(result).toEqual({
      ok: true,
      kind: 'text',
      path: resolvedPath,
      displayPath: resolvedPath,
      contents: 'downloaded notes\n',
      size: 17,
      isReadOnly: false,
      mimeType: 'text/plain',
    })
  })

  test('edits a project symlink at the external file it points to', async () => {
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
      isReadOnly: false,
    })

    expect(isInsideRoot(await realpath(projectRoot), await realpath(linkedPath))).toBe(false)
    expect(await readFile(externalPath, 'utf8')).toBe('outside\n')
  })
})
