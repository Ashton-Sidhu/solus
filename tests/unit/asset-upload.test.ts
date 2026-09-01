import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, readFile, readdir, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { writeAssetUpload } from '@solus/server/server/assets'

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
