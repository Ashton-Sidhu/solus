import { createServer, type Server as HttpServer, type IncomingMessage, type ServerResponse } from 'http'
import { existsSync, statSync, readFileSync, writeFileSync } from 'fs'
import { join, normalize, extname } from 'path'
import { tmpdir } from 'os'
import { consumePairToken, generatePairToken, getInstallationId, issueSessionToken, listRevokedDevices, revokeDevice } from './auth'
import { listReachableEndpoints } from './endpoints'
import { filePathsToAttachments } from './handlers/file-handlers'
import { createLogger } from '../logger'

const log = createLogger('main', 'http')

export interface HttpServerOptions {
  /** Bind address: defaults to 0.0.0.0 (all interfaces). Set 127.0.0.1 for loopback only. */
  host?: string
  /** Port; 0 lets the OS assign an ephemeral port. */
  port?: number
  /** Path to the prebuilt web client `dist/` directory; if present, mounted at /. */
  staticDir?: string
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'application/javascript; charset=utf-8',
  '.mjs':  'application/javascript; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg':  'image/svg+xml',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.gif':  'image/gif',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2':'font/woff2',
}

interface RouteCtx {
  req: IncomingMessage
  res: ServerResponse
  url: URL
}

type Route = (ctx: RouteCtx) => Promise<void> | void

/**
 * Builds the HTTP server. Returns a node http.Server that the caller
 * `.listen()`s separately. The WebSocket transport mounts itself at `/ws`
 * on the same server via `http.on('upgrade')`.
 */
export function buildHttpServer(opts: HttpServerOptions = {}): { server: HttpServer; host: string; port: number } {
  const host = opts.host ?? '0.0.0.0'
  const port = opts.port ?? 0

  const get = new Map<string, Route>()
  const post = new Map<string, Route>()

  get.set('/health', ({ res }) => json(res, 200, { ok: true, installationId: getInstallationId() }))

  get.set('/endpoints', ({ res }) => json(res, 200, { endpoints: listReachableEndpoints(host, port) }))

  post.set('/pair', async ({ req, res }) => {
    const body = await readJson(req)
    const pairToken = body?.pairToken ?? body?.code
    const deviceLabel = (body?.deviceLabel as string | undefined)?.slice(0, 64) || 'Unknown device'
    if (!pairToken || typeof pairToken !== 'string') {
      return json(res, 400, { error: 'pairToken or code required' })
    }
    if (!consumePairToken(pairToken)) {
      return json(res, 401, { error: 'Invalid or expired pair token' })
    }
    const sessionToken = issueSessionToken(deviceLabel)
    log.info(`pair: issued session for "${deviceLabel}"`)
    return json(res, 200, { sessionToken, installationId: getInstallationId() })
  })

  post.set('/upload', async ({ req, res }) => {
    try {
      const filePaths = await receiveMultipart(req)
      json(res, 200, { attachments: filePathsToAttachments(filePaths) })
    } catch (err) {
      log.error(`upload error: ${err}`)
      json(res, 500, { error: 'upload failed' })
    }
  })

  // Internal — Connections panel hits this from the Electron app to mint a fresh
  // pair token. External callers can hit it too, but a token alone is useless
  // without already having reach to the server.
  post.set('/auth/pair-token', ({ res }) => json(res, 200, generatePairToken()))

  post.set('/auth/revoke', async ({ req, res }) => {
    const body = await readJson(req)
    if (!body?.deviceId) return json(res, 400, { error: 'deviceId required' })
    revokeDevice(body.deviceId)
    return json(res, 200, { ok: true, revoked: listRevokedDevices() })
  })

  const server = createServer(async (req, res) => {
    setCors(res)
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return }

    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`)
    const ctx: RouteCtx = { req, res, url }

    const handler = req.method === 'GET' ? get.get(url.pathname)
      : req.method === 'POST' ? post.get(url.pathname)
      : null

    if (handler) {
      try { await handler(ctx) }
      catch (err) {
        log.error(`http handler error: ${err}`)
        if (!res.headersSent) json(res, 500, { error: 'internal' })
      }
      return
    }

    // Static fallback for the bundled client. Anything else 404s.
    if (req.method === 'GET' && opts.staticDir && existsSync(opts.staticDir)) {
      serveStatic(res, opts.staticDir, url.pathname)
      return
    }

    json(res, 404, { error: 'not found' })
  })

  return { server, host, port }
}

function setCors(res: ServerResponse): void {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Headers', 'authorization,content-type')
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS')
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.end(JSON.stringify(body))
}

async function readJson(req: IncomingMessage): Promise<any> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  if (chunks.length === 0) return null
  try { return JSON.parse(Buffer.concat(chunks).toString('utf-8')) }
  catch { return null }
}

async function receiveMultipart(req: IncomingMessage): Promise<string[]> {
  // Minimal multipart/form-data parser sufficient for browser file uploads.
  // We don't depend on a parser package because uploads are infrequent and
  // we trust the client (already authenticated via WS pair token).
  const ct = req.headers['content-type'] ?? ''
  const boundaryMatch = /boundary=([^\s;]+)/.exec(ct)
  if (!boundaryMatch) throw new Error('multipart boundary missing')
  const boundary = `--${boundaryMatch[1]}`

  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  const body = Buffer.concat(chunks)

  const parts = splitBuffer(body, Buffer.from(boundary))
  const written: string[] = []

  for (const part of parts) {
    // Drop preamble/epilogue (empty or trailing "--").
    if (part.length === 0 || (part.length <= 4 && part.toString().trim() === '--')) continue

    const headerEnd = part.indexOf('\r\n\r\n')
    if (headerEnd < 0) continue

    const headerStr = part.slice(0, headerEnd).toString()
    const data = part.slice(headerEnd + 4, part.length - 2) // strip trailing \r\n
    const filenameMatch = /filename="([^"]+)"/.exec(headerStr)
    if (!filenameMatch) continue

    const safeName = filenameMatch[1].replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 80) || 'upload'
    const dest = join(tmpdir(), `solus-upload-${Date.now()}-${safeName}`)
    writeFileSync(dest, data)
    written.push(dest)
  }

  return written
}

function splitBuffer(buf: Buffer, sep: Buffer): Buffer[] {
  const out: Buffer[] = []
  let start = 0
  let idx = buf.indexOf(sep, start)
  while (idx >= 0) {
    out.push(buf.slice(start, idx))
    start = idx + sep.length
    if (start < buf.length && buf[start] === 0x0d /* \r */ && buf[start + 1] === 0x0a /* \n */) {
      start += 2
    }
    idx = buf.indexOf(sep, start)
  }
  out.push(buf.slice(start))
  return out
}

function serveStatic(res: ServerResponse, root: string, reqPath: string): void {
  const safe = normalize(reqPath === '/' ? '/index.html' : reqPath).replace(/^(\.\.[/\\])+/, '')
  const full = join(root, safe)
  if (!full.startsWith(root)) { json(res, 404, { error: 'not found' }); return }

  if (!existsSync(full) || !statSync(full).isFile()) {
    // SPA fallback — serve index.html for unknown routes.
    const fallback = join(root, 'index.html')
    if (existsSync(fallback)) {
      const body = readFileSync(fallback)
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end(body)
      return
    }
    json(res, 404, { error: 'not found' })
    return
  }

  const ext = extname(full).toLowerCase()
  const type = MIME[ext] ?? 'application/octet-stream'
  res.writeHead(200, { 'content-type': type })
  res.end(readFileSync(full))
}
