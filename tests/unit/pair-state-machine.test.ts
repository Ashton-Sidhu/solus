import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import type { Server } from 'http'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { hostOperatingSystem } from '@solus/server/platform/host-operating-system'
import { z } from 'zod'

mock.module('node:sqlite', () => ({ DatabaseSync: Database }))

const { buildHttpServer } = await import('@solus/server/server/http')
const auth = await import('@solus/server/server/auth')

interface PairRequestBody {
  code: string
  deviceLabel?: string
}

const pairResponseSchema = z.object({
  sessionToken: z.string().optional(),
  os: z.string().optional(),
})

describe('pairing clients', () => {
  const originalDataDir = process.env.SOLUS_DATA_DIR
  let dataDir: string

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'solus-pair-test-'))
    process.env.SOLUS_DATA_DIR = dataDir
    auth.resetAuthStateForTests()
  })

  afterEach(() => {
    auth.resetAuthStateForTests()
    rmSync(dataDir, { recursive: true, force: true })
    if (originalDataDir === undefined) delete process.env.SOLUS_DATA_DIR
    else process.env.SOLUS_DATA_DIR = originalDataDir
  })

  test('issues independent credentials to multiple clients', async () => {
    const { server, baseUrl } = await listen()
    try {
      const firstPairToken = auth.generatePairToken()
      const first = await postJson(`${baseUrl}/pair`, {
        code: firstPairToken.code,
        deviceLabel: 'First client',
      })
      const secondPairToken = auth.generatePairToken()
      const second = await postJson(`${baseUrl}/pair`, {
        code: secondPairToken.code,
        deviceLabel: 'Second client',
      })

      expect(first.status).toBe(200)
      expect(second.status).toBe(200)
      expect(first.body.sessionToken).not.toBe(second.body.sessionToken)
      expect(first.body.os).toBe(hostOperatingSystem())
      expect(auth.verifySessionToken(first.body.sessionToken)?.deviceLabel).toBe('First client')
      expect(auth.verifySessionToken(second.body.sessionToken)?.deviceLabel).toBe('Second client')

      const health = await fetch(`${baseUrl}/health`).then((response) => response.json())
      expect(health).not.toHaveProperty('claimable')
    } finally {
      await close(server)
    }
  })

  test('keeps each pair token one-time use', async () => {
    const pairToken = auth.generatePairToken()
    const { server, baseUrl } = await listen()
    try {
      expect((await postJson(`${baseUrl}/pair`, { code: pairToken.code })).status).toBe(200)
      expect((await postJson(`${baseUrl}/pair`, { code: pairToken.code })).status).toBe(401)
    } finally {
      await close(server)
    }
  })

  test('does not expose the removed authenticated pair-token HTTP path', async () => {
    const { server, baseUrl } = await listen()
    try {
      const response = await fetch(`${baseUrl}/auth/pair-token`, { method: 'POST' })
      expect(response.status).toBe(404)
    } finally {
      await close(server)
    }
  })

})

async function listen(): Promise<{ server: Server; baseUrl: string }> {
  const { server } = buildHttpServer({ host: '127.0.0.1', port: 0 })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject)
      resolve()
    })
  })
  const address = z.object({ port: z.number().int() }).safeParse(server.address())
  if (!address.success) throw new Error('test server did not bind to a TCP port')
  return { server, baseUrl: `http://127.0.0.1:${address.data.port}` }
}

async function close(server: Server): Promise<void> {
  await new Promise<void>((resolve) => server.close(() => resolve()))
}

async function postJson(url: string, body: PairRequestBody): Promise<{ status: number; body: z.infer<typeof pairResponseSchema> }> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  return { status: response.status, body: pairResponseSchema.parse(await response.json()) }
}
