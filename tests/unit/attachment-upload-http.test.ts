import { afterEach, describe, expect, mock, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'fs'
import { request as httpRequest, type Server as HttpServer } from 'http'
import { tmpdir } from 'os'
import { join } from 'path'
import type { IpcContext } from '@solus/contracts/types'

mock.module('node:sqlite', () => ({ DatabaseSync: Database }))
mock.module('@solus/server/project-config/projects-manifest', () => ({
  listProjects: async () => [],
}))

let http: HttpServer | null = null
let dataDir: string | null = null
const previousDataDir = process.env.SOLUS_DATA_DIR

afterEach(async () => {
  if (http) await new Promise<void>((resolve) => http!.close(() => resolve()))
  http = null
  if (dataDir) rmSync(dataDir, { recursive: true, force: true })
  dataDir = null
  if (previousDataDir === undefined) delete process.env.SOLUS_DATA_DIR
  else process.env.SOLUS_DATA_DIR = previousDataDir
})

/** Send a body with a Content-Length of our choosing, which fetch never allows. */
function post(url: string, body: Buffer, contentLength: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(url, { method: 'POST', headers: { 'content-length': String(contentLength) } }, (res) => {
      res.resume()
      resolve(res.statusCode ?? 0)
    })
    req.on('error', reject)
    req.end(body)
  })
}

// The upload URL carries its own capability, so it must work over the plain
// HTTP listener with no bearer token, and stream straight off the socket.
describe('POST /api/uploads/:token', () => {
  test('stores the body at the host path, without a bearer token', async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'solus-upload-http-'))
    process.env.SOLUS_DATA_DIR = dataDir
    const { buildHttpServer } = await import('@solus/server/server/http')
    const { createAttachmentUploadToken } = await import('@solus/server/server/handlers/attachment-handlers')

    http = buildHttpServer({ host: '127.0.0.1', port: 0 }).server
    await new Promise<void>((resolve) => http!.listen(0, '127.0.0.1', resolve))
    const address = http.address()
    if (!address || typeof address === 'string') throw new Error('expected TCP address')

    const bytes = Buffer.alloc(256 * 1024, 7)
    const ctx = { session: { sessionId: 'http-session' } } as IpcContext
    const { relativeUrl, hostPath } = await createAttachmentUploadToken(ctx, { name: 'flicker.mp4', mime: 'video/mp4', size: bytes.length })
    const url = `http://127.0.0.1:${address.port}${relativeUrl}`

    expect(await post(url, bytes.subarray(1), bytes.length - 1)).toBe(400)
    expect(existsSync(hostPath)).toBe(false)

    const response = await fetch(url, { method: 'POST', body: bytes })
    expect(response.status).toBe(204)
    expect(readFileSync(hostPath)).toEqual(bytes)
  })
})
