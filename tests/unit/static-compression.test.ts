import { afterEach, describe, expect, mock, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import type { Server } from 'http'
import { tmpdir } from 'os'
import { join } from 'path'

mock.module('node:sqlite', () => ({ DatabaseSync: Database }))

const { buildHttpServer } = await import('@solus/server/server/http')

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

describe('stale build requests', () => {
  test('404s a missing build file instead of serving the SPA shell as script', async () => {
    const staticDir = mkdtempSync(join(tmpdir(), 'solus-static-'))
    cleanups.push(() => rmSync(staticDir, { recursive: true, force: true }))
    writeFileSync(join(staticDir, 'index.html'), '<!doctype html><title>Solus</title>')

    const { server, baseUrl } = await listen(staticDir)
    cleanups.push(() => server.close())

    // A tab on a previous build asks for a chunk this build no longer has.
    // Answering with index.html makes the browser reject HTML as a module
    // rather than report the chunk as gone.
    const staleChunk = await fetch(`${baseUrl}/assets/await-M_YOPC_y.js`)
    expect(staleChunk.status).toBe(404)
    expect(staleChunk.headers.get('content-type')).not.toContain('text/html')

    // Client-side routes still resolve to the shell.
    const route = await fetch(`${baseUrl}/pair`)
    expect(route.status).toBe(200)
    expect(route.headers.get('content-type')).toContain('text/html')
  })

  test('revalidates the entry document while hashed assets stay immutable', async () => {
    const staticDir = mkdtempSync(join(tmpdir(), 'solus-static-'))
    cleanups.push(() => rmSync(staticDir, { recursive: true, force: true }))
    writeFileSync(join(staticDir, 'index.html'), '<!doctype html><title>Solus</title>')
    mkdirSync(join(staticDir, 'assets'))
    writeFileSync(join(staticDir, 'assets', 'index-lLoEVyX3.js'), 'export const build = 1\n')

    const { server, baseUrl } = await listen(staticDir)
    cleanups.push(() => server.close())

    // index.html names the current hashes, so a reload must never reuse the
    // cached copy that names the previous build's chunks.
    const shell = await fetch(`${baseUrl}/`)
    expect(shell.headers.get('cache-control')).toBe('no-cache')

    const asset = await fetch(`${baseUrl}/assets/index-lLoEVyX3.js`)
    expect(asset.status).toBe(200)
    expect(asset.headers.get('cache-control')).toContain('immutable')
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
