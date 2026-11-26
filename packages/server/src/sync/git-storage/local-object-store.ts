import { createHash, randomBytes } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdir, open, rename, stat, unlink } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { Readable } from 'node:stream'
import { z } from 'zod'
import { SESSION_CODE_CHECKSUM_HEADER } from '@solus/contracts/session-repositories'
import { readSignedToken, signToken } from '../../admission/signed-token'
import { encodeObjectKey, isSessionCodeKey, OBJECT_URL_TTL_SECONDS, type ObjectStore } from './object-store'

/** The Solus API serves the objects of a local store under this path. */
export const LOCAL_OBJECT_PATH = '/runner/session-code'

const tokenSchema = z.strictObject({
  purpose: z.literal('session-code'),
  key: z.string(),
  access: z.enum(['read', 'write']),
  bytes: z.number().int().positive(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  expiresAt: z.number().int(),
})
type ObjectToken = z.infer<typeof tokenSchema>

const refused = (status: 400 | 403 | 404, code: string) => Response.json({ code }, { status })

/**
 * Objects in a folder on the Solus API machine, for `SOLUS_SESSION_STORAGE=local-git`.
 * It stands in for R2: the API signs a URL with its asset signing secret, and the
 * same API receives and serves the bytes at that URL. A write checks the length and
 * the SHA-256 that the URL names before the file gets its name.
 */
export class LocalObjectStore implements ObjectStore {
  readonly storageScope: string
  constructor(private readonly root: string, private readonly secret: Buffer, private readonly now: () => number = Date.now) {
    this.storageScope = `file://${root}`
  }

  async signedUrl(key: string, access: 'read' | 'write', facts: { bytes: number; sha256: string }): Promise<string> {
    if (!isSessionCodeKey(key)) throw new Error('Invalid session code key.')
    const token: ObjectToken = { purpose: 'session-code', key, access, bytes: facts.bytes, sha256: facts.sha256, expiresAt: this.now() + OBJECT_URL_TTL_SECONDS * 1000 }
    return `${LOCAL_OBJECT_PATH}/${encodeObjectKey(key)}?${new URLSearchParams({ token: signToken(token, this.secret) })}`
  }

  /** The token, when it is signed here, is not expired, and names this key and access. */
  private admit(key: string, token: string, access: 'read' | 'write'): ObjectToken | null {
    const payload = readSignedToken(token, this.secret, tokenSchema)
    if (!payload || payload.key !== key || payload.access !== access || payload.expiresAt <= this.now() || !isSessionCodeKey(key)) return null
    return payload
  }

  private path(key: string): string {
    return join(this.root, ...key.split('/'))
  }

  /** A PUT. A repeated upload of a key that is already there succeeds: the key names its bytes. */
  async receive(key: string, token: string, request: Request): Promise<Response> {
    const payload = this.admit(key, token, 'write')
    if (!payload) return refused(403, 'forbidden')
    if (request.headers.get('content-length') !== String(payload.bytes)
      || request.headers.get(SESSION_CODE_CHECKSUM_HEADER) !== Buffer.from(payload.sha256, 'hex').toString('base64')) return refused(403, 'forbidden')
    const path = this.path(key)
    if (await stat(path).then(file => file.isFile(), () => false)) {
      await request.body?.cancel()
      return new Response(null, { status: 200 })
    }
    if (!request.body) return refused(400, 'bad_digest')
    await mkdir(dirname(path), { recursive: true })
    const partial = `${path}.${randomBytes(8).toString('hex')}.partial`
    const file = await open(partial, 'wx', 0o600)
    const hash = createHash('sha256')
    let written = 0
    let complete = false
    try {
      for await (const chunk of request.body) {
        written += chunk.byteLength
        if (written > payload.bytes) break
        hash.update(chunk)
        await file.write(chunk)
      }
      await file.close()
      if (written !== payload.bytes || hash.digest('hex') !== payload.sha256) return refused(400, 'bad_digest')
      await rename(partial, path)
      complete = true
      return new Response(null, { status: 200 })
    } finally {
      if (!complete) {
        await file.close().catch(() => {})
        await unlink(partial).catch(() => {})
      }
    }
  }

  /** A GET streams the file. The reader checks its hash. */
  async serve(key: string, token: string): Promise<Response> {
    if (!this.admit(key, token, 'read')) return refused(403, 'forbidden')
    const path = this.path(key)
    const file = await stat(path).catch(() => null)
    if (!file?.isFile()) return refused(404, 'not_found')
    // SAFETY: the Node web stream is the same ReadableStream that Response reads; only the two type declarations differ.
    return new Response(Readable.toWeb(createReadStream(path)) as ReadableStream, {
      headers: { 'content-type': 'application/octet-stream', 'content-length': String(file.size) },
    })
  }
}
