import { attachmentsRoot, uploadFolderName } from '@solus/server/data/assets/attachment-store'
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import type { IpcContext } from '@solus/contracts/types'
import { createAssetUrl, createFileDownloadUrl, serveAssetToken } from '@solus/server/data/assets/assets'

const secret = Buffer.alloc(32, 7)
const now = 1_000

describe('signed URLs for host media files', () => {
  let sandbox = ''
  let projectRoot = ''
  let ctx: IpcContext

  beforeEach(async () => {
    sandbox = await mkdtemp(join(tmpdir(), 'solus-host-asset-'))
    projectRoot = join(sandbox, 'project')
    await mkdir(projectRoot)
    // SAFETY: signing reads only the project directories, to resolve relative paths.
    ctx = { session: { projectPath: projectRoot, workingDirectory: projectRoot } } as IpcContext
  })

  afterEach(async () => {
    if (sandbox) await rm(sandbox, { recursive: true, force: true })
  })

  async function serve(relativeUrl: string, range?: string): Promise<Response> {
    return serveAssetToken(relativeUrl.replace('/api/assets/', ''), { method: 'GET', range }, { secret, now })
  }

  test('signs a media file anywhere on the host, not only in the project', async () => {
    // WHY: an agent often writes a screenshot to /tmp and shows it in its reply.
    // Every client, desktop included, now loads it through this URL.
    const path = join(sandbox, 'shot.png')
    await writeFile(path, Buffer.from([137, 80, 78, 71]))
    const { relativeUrl } = await createAssetUrl(ctx, { path }, { secret, now })
    const response = await serve(relativeUrl)
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('image/png')
  })

  test('resolves a relative path against the session project', async () => {
    await writeFile(join(projectRoot, 'diagram.avif'), Buffer.from([1, 2, 3]))
    const { relativeUrl } = await createAssetUrl(ctx, { path: 'diagram.avif' }, { secret, now })
    expect((await serve(relativeUrl)).headers.get('content-type')).toBe('image/avif')
    await expect(createAssetUrl(undefined, { path: 'diagram.avif' }, { secret, now })).rejects.toThrow()
  })

  test('downloads the exact checkout file and rejects a symlink that leaves it', async () => {
    await writeFile(join(projectRoot, 'notes.md'), '# Notes')
    const { relativeUrl } = await createFileDownloadUrl(ctx, { path: 'notes.md', name: 'café.md' }, { scope: null, secret, now })
    const response = await serve(relativeUrl)
    expect(response.headers.get('content-type')).toBe('application/octet-stream')
    expect(response.headers.get('content-disposition')).toContain("filename*=UTF-8''caf%C3%A9.md")
    expect(await response.text()).toBe('# Notes')
    const outside = join(sandbox, 'outside.md')
    await writeFile(outside, 'outside')
    await symlink(outside, join(projectRoot, 'link.md'))
    await expect(createFileDownloadUrl(ctx, { path: 'link.md' }, { scope: null, secret, now })).rejects.toThrow('outside')
    const restricted = join(projectRoot, 'allowed')
    await mkdir(restricted)
    await expect(createFileDownloadUrl(ctx, { path: 'notes.md' }, { scope: restricted, secret, now })).rejects.toThrow('outside')
  })

  test('serves a PDF and seeks a video by byte range', async () => {
    await writeFile(join(projectRoot, 'spec.pdf'), '%PDF-1.4')
    await writeFile(join(projectRoot, 'demo.mov'), Buffer.from([0, 1, 2, 3, 4, 5]))
    const pdf = await createAssetUrl(ctx, { path: 'spec.pdf' }, { secret, now })
    expect((await serve(pdf.relativeUrl)).headers.get('content-type')).toBe('application/pdf')

    const video = await createAssetUrl(ctx, { path: 'demo.mov' }, { secret, now })
    const partial = await serve(video.relativeUrl, 'bytes=2-3')
    expect(partial.status).toBe(206)
    expect(new Uint8Array(await partial.arrayBuffer())).toEqual(new Uint8Array([2, 3]))
  })

  test('serves a raster image whose name has no extension by reading its bytes', async () => {
    // WHY: an agent often saves a download as `/tmp/shots/pr_4`. Its reply embeds
    // that path, and the image must still show.
    const path = join(sandbox, 'pr_4')
    await writeFile(path, Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0]))
    const { relativeUrl } = await createAssetUrl(ctx, { path }, { secret, now })
    const response = await serve(relativeUrl)
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('image/png')
  })

  test('refuses a file with no extension whose bytes are not a raster image', async () => {
    await writeFile(join(projectRoot, 'credentials'), 'TOKEN=secret')
    await writeFile(join(projectRoot, 'logo'), '<svg xmlns="http://www.w3.org/2000/svg"><script/></svg>')
    await expect(createAssetUrl(ctx, { path: 'credentials' }, { secret, now })).rejects.toThrow('This asset type is not allowed.')
    await expect(createAssetUrl(ctx, { path: 'logo' }, { secret, now })).rejects.toThrow('This asset type is not allowed.')
  })

  test('serves a document uploaded for this session and refuses paths outside its upload folder', async () => {
    const sessionId = crypto.randomUUID()
    const folder = join(attachmentsRoot(), uploadFolderName(sessionId))
    const path = join(folder, 'notes.md')
    await mkdir(folder, { recursive: true })
    try {
      await writeFile(path, '# Notes')
      ctx.session.sessionId = sessionId
      const { relativeUrl } = await createAssetUrl(ctx, { path }, { secret, now })
      const response = await serve(relativeUrl)
      expect(await response.text()).toBe('# Notes')
      expect(response.headers.get('Content-Disposition')).toContain('attachment')
      expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff')
      const outside = join(projectRoot, 'project.md')
      await writeFile(outside, 'outside')
      const link = join(folder, 'link.md')
      await symlink(outside, link)
      await expect(createAssetUrl(ctx, { path: link }, { secret, now })).rejects.toThrow('not allowed')
      ctx.session.sessionId = 'another-session'
      await expect(createAssetUrl(ctx, { path }, { secret, now })).rejects.toThrow('not allowed')
      await rm(path)
      await symlink(outside, path)
      expect((await serve(relativeUrl)).status).toBe(404)
    } finally {
      await rm(folder, { recursive: true, force: true })
    }
  })

  test('refuses any file that is not media, so a signed URL never serves source or secrets', async () => {
    await writeFile(join(projectRoot, '.env'), 'TOKEN=secret')
    await writeFile(join(projectRoot, 'notes.txt'), 'notes')
    await expect(createAssetUrl(ctx, { path: '.env' }, { secret, now })).rejects.toThrow('This asset type is not allowed.')
    await expect(createAssetUrl(ctx, { path: 'notes.txt' }, { secret, now })).rejects.toThrow('This asset type is not allowed.')
  })
})
