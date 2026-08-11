import { afterEach, describe, expect, mock, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import type { Server } from 'http'
import { tmpdir } from 'os'
import { join } from 'path'

mock.module('node:sqlite', () => ({ DatabaseSync: Database }))

const { buildHttpServer } = await import('../../src/main/server/http')

const cleanups: Array<() => void> = []

afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup()
})

describe('bundled client compression', () => {
  test('compresses a static asset and leaves byte ranges unencoded', async () => {
    const staticDir = mkdtempSync(join(tmpdir(), 'solus-static-'))
    cleanups.push(() => rmSync(staticDir, { recursive: true, force: true }))
    const source = 'const payload = "wire budget";\n'.repeat(200)
    writeFileSync(join(staticDir, 'app.js'), source)

    const { server, baseUrl } = await listen(staticDir)
    cleanups.push(() => server.close())

    const compressed = await fetch(`${baseUrl}/app.js`, {
      headers: { 'accept-encoding': 'gzip' },
    })
    expect(compressed.status).toBe(200)
    expect(compressed.headers.get('content-encoding')).toBe('gzip')
    expect(await compressed.text()).toBe(source)

    const range = await fetch(`${baseUrl}/app.js`, {
      headers: { 'accept-encoding': 'gzip', range: 'bytes=0-9' },
    })
    expect(range.status).toBe(206)
    expect(range.headers.get('content-encoding')).toBeNull()
    expect(await range.text()).toBe(source.slice(0, 10))
  })
})

async function listen(staticDir: string): Promise<{ server: Server; baseUrl: string }> {
  const { server } = buildHttpServer({ host: '127.0.0.1', port: 0, staticDir })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject)
      resolve()
    })
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('expected TCP address')
  return { server, baseUrl: `http://127.0.0.1:${address.port}` }
}
