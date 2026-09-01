import { afterEach, describe, expect, mock, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { Server as HttpServer } from 'http'
import { issueSessionToken, resetAuthStateForTests } from '@solus/server/server/auth'
import { encodePcm16Wav } from '@solus/contracts/voice-audio'

mock.module('@solus/server/project-config/projects-manifest', () => ({
  listProjects: async () => [],
}))

let http: HttpServer | null = null
let dataDir: string | null = null
const previousDataDir = process.env.SOLUS_DATA_DIR

afterEach(async () => {
  if (http) await new Promise<void>((resolve) => http!.close(() => resolve()))
  http = null
  resetAuthStateForTests()
  if (dataDir) rmSync(dataDir, { recursive: true, force: true })
  dataDir = null
  if (previousDataDir === undefined) delete process.env.SOLUS_DATA_DIR
  else process.env.SOLUS_DATA_DIR = previousDataDir
})

describe('long-form voice HTTP transport', () => {
  test('authenticates and transcribes a PCM16 WAV upload', async () => {
    const { buildHttpServer } = await import('@solus/server/server/http')
    dataDir = mkdtempSync(join(tmpdir(), 'solus-voice-http-'))
    process.env.SOLUS_DATA_DIR = dataDir
    resetAuthStateForTests()

    let received: Float32Array | null = null
    const built = buildHttpServer({
      host: '127.0.0.1',
      port: 0,
      transcribeAudio: async (samples) => {
        received = samples
        return { error: null, transcript: 'Recovered idea dump.' }
      },
    })
    http = built.server
    await new Promise<void>((resolve) => http!.listen(0, '127.0.0.1', resolve))
    const address = http.address()
    if (!address || typeof address === 'string') throw new Error('expected TCP address')
    const url = `http://127.0.0.1:${address.port}/voice/transcribe`
    const wav = encodePcm16Wav(Float32Array.from([-1, -0.25, 0, 0.25, 1]))

    const unauthorized = await fetch(url, { method: 'POST', body: wav })
    expect(unauthorized.status).toBe(401)

    const token = issueSessionToken('Voice test').token
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'audio/wav',
      },
      body: wav,
    })

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ error: null, transcript: 'Recovered idea dump.' })
    expect(received).not.toBeNull()
    expect(received!.length).toBe(5)
    expect(received![0]).toBe(-1)
    expect(Math.abs(received![3] - 0.25)).toBeLessThan(1 / 0x7fff)
  })

  test('rejects a concurrent upload before decoding another body', async () => {
    const { buildHttpServer } = await import('@solus/server/server/http')
    dataDir = mkdtempSync(join(tmpdir(), 'solus-voice-http-'))
    process.env.SOLUS_DATA_DIR = dataDir
    resetAuthStateForTests()

    let releaseFirst!: () => void
    const firstMayFinish = new Promise<void>((resolve) => { releaseFirst = resolve })
    let noteStarted!: () => void
    const started = new Promise<void>((resolve) => { noteStarted = resolve })
    const built = buildHttpServer({
      host: '127.0.0.1',
      port: 0,
      transcribeAudio: async () => {
        noteStarted()
        await firstMayFinish
        return { error: null, transcript: 'first' }
      },
    })
    http = built.server
    await new Promise<void>((resolve) => http!.listen(0, '127.0.0.1', resolve))
    const address = http.address()
    if (!address || typeof address === 'string') throw new Error('expected TCP address')
    const url = `http://127.0.0.1:${address.port}/voice/transcribe`
    const token = issueSessionToken('Voice test').token
    const wav = encodePcm16Wav(Float32Array.of(0))
    const request = () => fetch(url, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'audio/wav' },
      body: wav,
    })

    const first = request()
    await started
    const second = await request()
    expect(second.status).toBe(429)
    expect(await second.json()).toEqual({
      error: 'Voice transcription is already in progress',
      transcript: null,
    })
    releaseFirst()
    expect((await first).status).toBe(200)
  })
})
