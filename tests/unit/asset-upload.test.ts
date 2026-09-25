import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { randomBytes } from 'crypto'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import type { IpcContext } from '@solus/contracts/types'
import { createAssetUrl, serveAssetToken, writeAssetBytes, writeAssetUpload } from '@solus/server/server/assets'

const PNG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3, 4])

function dataUrl(bytes: Buffer, mime = 'image/png'): string {
  return `data:${mime};base64,${bytes.toString('base64')}`
}

describe('content-addressed asset uploads', () => {
  let assetsDir = ''

  beforeEach(async () => {
    assetsDir = await mkdtemp(join(tmpdir(), 'solus-assets-'))
  })

  afterEach(async () => {
    if (assetsDir) await rm(assetsDir, { recursive: true, force: true })
  })

  test('stores one immutable file for repeated image bytes', async () => {
    const request = { name: 'screen.png', mime: 'image/png' as const, dataUrl: dataUrl(PNG) }
    const first = await writeAssetUpload(request, { assetsDir })
    const second = await writeAssetUpload(request, { assetsDir })

    expect(second).toEqual(first)
    expect(first.uri).toBe(`asset://${first.id}`)
    expect(first.id).toMatch(/^[a-f0-9]{64}\.png$/)
    expect(await readdir(assetsDir)).toEqual([first.id])
    expect(await readFile(join(assetsDir, first.id))).toEqual(PNG)
  })

  test('rejects bytes that do not match the declared image type', async () => {
    await expect(writeAssetUpload({
      name: 'fake.png',
      mime: 'image/png',
      dataUrl: dataUrl(Buffer.from('not a png')),
    }, { assetsDir })).rejects.toThrow('does not match')
  })

  test('stores a general file without treating its bytes as inline content', async () => {
    const bytes = Buffer.from('quarter,total\nQ1,42\n')
    const result = await writeAssetUpload({
      name: 'report.csv',
      mime: 'text/csv',
      dataUrl: dataUrl(bytes, 'text/csv'),
    }, { assetsDir })

    expect(result.id).toMatch(/^[a-f0-9]{64}\.csv$/)
    expect(result.uri).toBe(`asset://${result.id}`)
    expect(await readFile(join(assetsDir, result.id))).toEqual(bytes)
  })

  test('does not let unverified files claim an inline image extension', async () => {
    const result = await writeAssetUpload({
      name: 'payload.png',
      mime: 'application/octet-stream',
      dataUrl: dataUrl(Buffer.from('not an image'), 'application/octet-stream'),
    }, { assetsDir })

    expect(result.id).toMatch(/^[a-f0-9]{64}\.bin$/)
  })
})

describe('serving video assets', () => {
  let assetsDir = ''
  const secret = randomBytes(32)
  const MP4 = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypisom'), Buffer.alloc(64, 1)])

  beforeEach(async () => {
    assetsDir = await mkdtemp(join(tmpdir(), 'solus-video-assets-'))
  })

  afterEach(async () => {
    if (assetsDir) await rm(assetsDir, { recursive: true, force: true })
  })

  const tokenFor = async (request: { assetId?: string; path?: string }, ctx?: IpcContext) => {
    const { relativeUrl } = await createAssetUrl(ctx, request, { secret, assetsDir })
    return relativeUrl.slice('/api/assets/'.length)
  }

  // A recording is stored by the host itself, then published by id: the id must
  // keep the `.mp4` that GitHub's upload and the player both key on.
  test('stores host-made bytes under a content address with their extension', async () => {
    const stored = await writeAssetBytes(MP4, 'mp4', { assetsDir })

    expect(stored.id).toMatch(/^[a-f0-9]{64}\.mp4$/)
    expect(stored.mime).toBe('video/mp4')
    expect(await readFile(join(assetsDir, stored.id))).toEqual(MP4)
    await expect(writeAssetBytes(MP4, '../mp4', { assetsDir })).rejects.toThrow('extension')
  })

  // A video that downloads instead of playing is the bug this closes; the range
  // answer is what lets a player seek without fetching the whole file.
  test('a stored video plays inline and answers range requests', async () => {
    const { id } = await writeAssetBytes(MP4, 'mp4', { assetsDir })
    const token = await tokenFor({ assetId: id })

    const full = await serveAssetToken(token, { method: 'GET' }, { secret })
    expect(full.status).toBe(200)
    expect(full.headers.get('content-type')).toBe('video/mp4')
    expect(full.headers.get('content-disposition')).toBeNull()
    expect(full.headers.get('x-content-type-options')).toBe('nosniff')
    expect(full.headers.get('content-security-policy')).toContain("media-src 'self'")

    const part = await serveAssetToken(token, { method: 'GET', range: 'bytes=4-11' }, { secret })
    expect(part.status).toBe(206)
    expect(part.headers.get('content-range')).toBe(`bytes 4-11/${MP4.length}`)
    expect(Buffer.from(await part.arrayBuffer()).toString()).toBe('ftypisom')
  })

  test('an agent-authored video path plays inline with its video type', async () => {
    const project = await mkdtemp(join(tmpdir(), 'solus-video-project-'))
    try {
      await writeFile(join(project, 'demo.mov'), MP4)
      const ctx = { session: { sessionId: 's', projectPath: project } } as IpcContext
      const response = await serveAssetToken(await tokenFor({ path: join(project, 'demo.mov') }, ctx), { method: 'GET' }, { secret })

      expect(response.status).toBe(200)
      expect(response.headers.get('content-type')).toBe('video/quicktime')
      expect(response.headers.get('content-disposition')).toBeNull()
    } finally {
      await rm(project, { recursive: true, force: true })
    }
  })

  test('an unknown stored binary still downloads', async () => {
    const { id } = await writeAssetBytes(Buffer.from('opaque'), 'bin', { assetsDir })
    const response = await serveAssetToken(await tokenFor({ assetId: id }), { method: 'GET' }, { secret })

    expect(response.headers.get('content-type')).toBe('application/octet-stream')
    expect(response.headers.get('content-disposition')).toStartWith('attachment;')
  })
})
