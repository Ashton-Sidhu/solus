import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, mkdir, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import type { IpcContext } from '@solus/contracts/types'
import { createAssetUrl, serveAssetToken } from '@solus/server/data/assets/assets'

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

  test('refuses any file that is not media, so a signed URL never serves source or secrets', async () => {
    await writeFile(join(projectRoot, '.env'), 'TOKEN=secret')
    await writeFile(join(projectRoot, 'notes.txt'), 'notes')
    await expect(createAssetUrl(ctx, { path: '.env' }, { secret, now })).rejects.toThrow('This asset type is not allowed.')
    await expect(createAssetUrl(ctx, { path: 'notes.txt' }, { secret, now })).rejects.toThrow('This asset type is not allowed.')
  })
})
