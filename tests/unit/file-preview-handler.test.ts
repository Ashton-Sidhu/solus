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

  test('identifies a directory only inside the shared checkout', async () => {
    const path = join(projectRoot, 'docs')
    await mkdir(path)
    expect(await readFilePreview(ctx, { path }, projectRoot)).toMatchObject({ ok: false, isDirectory: true })
    const outside = await readFilePreview(ctx, { path: externalRoot }, projectRoot)
    expect(outside.ok).toBe(false)
    expect(outside).not.toHaveProperty('isDirectory', true)
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

  test('opens a citation on the correct local line of a bounded page', async () => {
    const path = join(projectRoot, 'long.txt')
    const line = 'a'.repeat(1023) + '\n'
    await writeFile(path, line.repeat(1100))
    const result = await readFilePreview(ctx, { path, textPage: { index: 0, line: 1001 } })
    expect(result).toMatchObject({ ok: true, page: { index: 31, targetLine: 9 } })
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

  test('reads all pages of a large text file without splitting UTF-8 characters', async () => {
    const path = join(projectRoot, 'large.txt')
    const contents = ('a'.repeat(32 * 1024 - 1) + '🌍').repeat(34) + '\nlast line'
    await writeFile(path, contents)
    const first = await readFilePreview(ctx, { path, textPage: { index: 0 } })
    if (!first.ok || first.kind !== 'text' || !first.page) throw new Error('Expected a text page')
    expect(first.isReadOnly).toBe(true)
    const legacy = await readFilePreview(ctx, { path })
    expect(legacy).toMatchObject({ ok: true, kind: 'text', isReadOnly: true, truncated: true })
    expect(await readFilePreview(ctx, { path, textPage: { index: first.page.count, revision: first.page.revision } }))
      .toMatchObject({ ok: false, error: 'This preview page is unavailable.' })
    let combined = first.contents
    for (let index = 1; index < first.page.count; index++) {
      const next = await readFilePreview(ctx, { path, textPage: { index, revision: first.page.revision } })
      if (!next.ok || next.kind !== 'text') throw new Error('Expected the next text page')
      expect(Buffer.byteLength(next.contents)).toBeLessThanOrEqual(32 * 1024 + 3)
      combined += next.contents
    }
    expect(combined).toBe(contents)
    await writeFile(path, contents + '\nchanged')
    expect(await readFilePreview(ctx, { path, textPage: { index: 1, revision: first.page.revision } }))
      .toMatchObject({ ok: false, error: 'The file changed. Reload the preview.' })
  })

  test('refuses a file outside the canonical guest scope, including a symlink', async () => {
    const path = join(projectRoot, 'link.txt')
    const outside = join(externalRoot, 'outside.txt')
    await writeFile(outside, 'private')
    await symlink(outside, path)
    expect(await readFilePreview(ctx, { path, textPage: { index: 0 } }, projectRoot))
      .toMatchObject({ ok: false, path })
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
