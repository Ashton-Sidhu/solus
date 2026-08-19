import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { handleArtifactRequest } from '@solus/desktop-main/artifact-protocol'

let fixtureDir = ''
let imagePath = ''
const bytes = new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7, 8, 9])

beforeAll(async () => {
  fixtureDir = await mkdtemp(join(tmpdir(), 'solus-artifact-protocol-'))
  imagePath = join(fixtureDir, 'fixture.png')
  await writeFile(imagePath, bytes)
})

afterAll(async () => {
  await rm(fixtureDir, { recursive: true, force: true })
})

function artifactRequest(path: string, init?: RequestInit, optional = false): Request {
  const query = `p=${encodeURIComponent(path)}${optional ? '&optional=1' : ''}`
  return new Request(`solus-artifact://local/?${query}`, init)
}

describe('desktop artifact protocol', () => {
  test('streams the complete file with bounded response headers', async () => {
    const response = await handleArtifactRequest(artifactRequest(imagePath))
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('image/png')
    expect(response.headers.get('content-length')).toBe(String(bytes.length))
    expect(response.headers.get('accept-ranges')).toBe('bytes')
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes)
  })

  test('serves bounded, open-ended, and suffix byte ranges', async () => {
    for (const [header, expected] of [
      ['bytes=2-4', [2, 3, 4]],
      ['bytes=7-', [7, 8, 9]],
      ['bytes=-2', [8, 9]],
    ] as const) {
      const response = await handleArtifactRequest(artifactRequest(imagePath, { headers: { range: header } }))
      expect(response.status).toBe(206)
      expect(response.headers.get('content-length')).toBe(String(expected.length))
      expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array(expected))
    }
  })

  test('rejects invalid ranges and supports body-free HEAD requests', async () => {
    const invalid = await handleArtifactRequest(artifactRequest(imagePath, {
      headers: { range: 'bytes=20-' },
    }))
    expect(invalid.status).toBe(416)
    expect(invalid.headers.get('content-range')).toBe(`bytes */${bytes.length}`)

    const head = await handleArtifactRequest(artifactRequest(imagePath, { method: 'HEAD' }))
    expect(head.status).toBe(200)
    expect(head.headers.get('content-length')).toBe(String(bytes.length))
    expect((await head.arrayBuffer()).byteLength).toBe(0)
  })

  test('preserves missing, optional, unsupported, and method responses', async () => {
    const missingPath = join(fixtureDir, 'missing.png')
    expect((await handleArtifactRequest(artifactRequest(missingPath))).status).toBe(404)
    expect((await handleArtifactRequest(artifactRequest(missingPath, undefined, true))).status).toBe(204)
    expect((await handleArtifactRequest(artifactRequest(join(fixtureDir, 'fixture.txt')))).status).toBe(415)

    const method = await handleArtifactRequest(artifactRequest(imagePath, { method: 'POST' }))
    expect(method.status).toBe(405)
    expect(method.headers.get('allow')).toBe('GET, HEAD')
  })
})
