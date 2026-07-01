import { createServer } from 'http'
import { createHash, randomBytes } from 'crypto'
import { app, safeStorage, shell } from 'electron'
import { net } from 'electron'
import { existsSync, readFileSync, writeFileSync, unlinkSync } from 'fs'
import { join } from 'path'
import { createLogger } from '../logger'
import { GOOGLE_CLIENT_ID } from './client-id'
import { GOOGLE_CLIENT_SECRET } from './client-secret'

const log = createLogger('main', 'google-oauth')

const TOKEN_FILE = join(app.getPath('userData'), 'google-oauth.bin')

const TOKEN_URL = 'https://oauth2.googleapis.com/token'
const AUTH_BASE = 'https://accounts.google.com/o/oauth2/v2/auth'
const SCOPE = 'https://www.googleapis.com/auth/drive.file'

interface StoredToken {
  refreshToken: string
  accessToken: string
  expiresAt: number
}

function loadStored(): StoredToken | null {
  if (!existsSync(TOKEN_FILE)) return null
  try {
    const encrypted = readFileSync(TOKEN_FILE)
    const json = safeStorage.decryptString(encrypted)
    return JSON.parse(json) as StoredToken
  } catch {
    return null
  }
}

function persist(token: StoredToken): void {
  try {
    const encrypted = safeStorage.encryptString(JSON.stringify(token))
    writeFileSync(TOKEN_FILE, encrypted, { mode: 0o600 })
  } catch (err) {
    log.warn(`Failed to persist token: ${err}`)
  }
}

function base64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '')
}

function generatePKCE(): { verifier: string; challenge: string } {
  const verifier = base64url(randomBytes(32))
  const challenge = base64url(createHash('sha256').update(verifier).digest())
  return { verifier, challenge }
}

function netPost(url: string, body: string, contentType: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = net.request({ method: 'POST', url })
    req.setHeader('Content-Type', contentType)
    req.on('response', (res) => {
      let data = ''
      res.on('data', (chunk) => { data += chunk.toString() })
      res.on('end', () => resolve({ status: res.statusCode, body: data }))
    })
    req.on('error', reject)
    req.write(body)
    req.end()
  })
}

async function exchangeCode(code: string, redirectUri: string, verifier: string): Promise<StoredToken> {
  const params = new URLSearchParams({
    code,
    client_id: GOOGLE_CLIENT_ID,
    client_secret: GOOGLE_CLIENT_SECRET,
    redirect_uri: redirectUri,
    grant_type: 'authorization_code',
    code_verifier: verifier,
  })
  const res = await netPost(TOKEN_URL, params.toString(), 'application/x-www-form-urlencoded')
  if (res.status !== 200) throw new Error(`Token exchange failed: ${res.body}`)
  const data = JSON.parse(res.body) as { access_token: string; refresh_token: string; expires_in: number }
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresAt: Date.now() + data.expires_in * 1000 - 30_000,
  }
}

async function refreshAccessToken(refreshToken: string): Promise<StoredToken> {
  const params = new URLSearchParams({
    refresh_token: refreshToken,
    client_id: GOOGLE_CLIENT_ID,
    client_secret: GOOGLE_CLIENT_SECRET,
    grant_type: 'refresh_token',
  })
  const res = await netPost(TOKEN_URL, params.toString(), 'application/x-www-form-urlencoded')
  if (res.status !== 200) throw new Error(`Token refresh failed: ${res.body}`)
  const data = JSON.parse(res.body) as { access_token: string; expires_in: number; refresh_token?: string }
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token ?? refreshToken,
    expiresAt: Date.now() + data.expires_in * 1000 - 30_000,
  }
}

function runOAuthFlow(): Promise<StoredToken> {
  const { verifier, challenge } = generatePKCE()

  return new Promise((resolve, reject) => {
    let redirectUri = ''

    const server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', `http://127.0.0.1`)
      const code = url.searchParams.get('code')
      const error = url.searchParams.get('error')

      // Ignore extraneous requests (favicon, preconnects) that lack callback params.
      if (!code && !error) {
        res.writeHead(204)
        res.end()
        return
      }

      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end('<html><body><p>Authentication complete. You may close this tab.</p></body></html>')
      server.close()

      if (error || !code) {
        reject(new Error(error ?? 'No code returned'))
        return
      }

      exchangeCode(code, redirectUri, verifier).then(resolve).catch(reject)
    })

    server.on('error', reject)

    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as { port: number }
      redirectUri = `http://127.0.0.1:${addr.port}`

      const params = new URLSearchParams({
        client_id: GOOGLE_CLIENT_ID,
        redirect_uri: redirectUri,
        response_type: 'code',
        scope: SCOPE,
        code_challenge: challenge,
        code_challenge_method: 'S256',
        access_type: 'offline',
        prompt: 'consent',
      })

      shell.openExternal(`${AUTH_BASE}?${params.toString()}`).catch(reject)
    })

    const timeout = setTimeout(() => {
      server.close()
      reject(new Error('OAuth flow timed out'))
    }, 5 * 60_000)

    server.on('close', () => clearTimeout(timeout))
  })
}

export async function getAccessToken(): Promise<string> {
  if (!GOOGLE_CLIENT_ID) throw new Error('Google client ID not configured')
  if (!GOOGLE_CLIENT_SECRET) throw new Error('Google client secret not configured')

  const stored = loadStored()
  if (stored) {
    if (Date.now() < stored.expiresAt) return stored.accessToken
    try {
      const refreshed = await refreshAccessToken(stored.refreshToken)
      persist(refreshed)
      return refreshed.accessToken
    } catch (err) {
      log.warn(`Refresh failed, re-authenticating: ${err}`)
    }
  }

  const token = await runOAuthFlow()
  persist(token)
  return token.accessToken
}

export function disconnect(): void {
  try {
    if (existsSync(TOKEN_FILE)) unlinkSync(TOKEN_FILE)
  } catch {}
}
