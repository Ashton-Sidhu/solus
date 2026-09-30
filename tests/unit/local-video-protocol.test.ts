import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { handleLocalVideoRequest } from '@solus/desktop-main/local-video-protocol'

let fixtureDir = ''
const bytes = new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7, 8, 9])

beforeAll(async () => {
  fixtureDir = await mkdtemp(join(tmpdir(), 'solus-local-video-protocol-'))
  await writeFile(join(fixtureDir, 'recording.mov'), bytes)
  await writeFile(join(fixtureDir, 'secret.png'), bytes)
})

afterAll(async () => {
  await rm(fixtureDir, { recursive: true, force: true })
})

function videoRequest(path: string, init?: RequestInit): Request {
  return new Request(`solus-local-video://local/?p=${encodeURIComponent(path)}`, init)
}

describe('desktop local video protocol', () => {
  test('streams a whole video with its type, so it uploads to a remote host', async () => {
    const response = await handleLocalVideoRequest(videoRequest(join(fixtureDir, 'recording.mov')))
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('video/quicktime')
    expect(response.headers.get('content-length')).toBe(String(bytes.length))
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes)
  })

  test('serves videos only: any other file loads from a signed host URL', async () => {
    // WHY: the renderer reads host files through the host. A scheme that reads
    // any local path would be a second way in that the web client does not have.
    expect((await handleLocalVideoRequest(videoRequest(join(fixtureDir, 'secret.png')))).status).toBe(415)
  })

  test('answers missing files and other methods plainly', async () => {
    expect((await handleLocalVideoRequest(videoRequest(join(fixtureDir, 'missing.mp4')))).status).toBe(404)
    const post = await handleLocalVideoRequest(videoRequest(join(fixtureDir, 'recording.mov'), { method: 'POST' }))
    expect(post.status).toBe(405)
  })
})
