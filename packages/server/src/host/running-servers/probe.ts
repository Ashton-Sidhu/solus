import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import type { ServerEndpoint } from '@solus/contracts/running-servers'
const PROBE_TIMEOUT_MS = 1500
const MAX_TITLE_BYTES = 16_384
export type ProbeResult = { kind: 'http'; response: NonNullable<ServerEndpoint['response']>; protocol: 'http' | 'https' } | { kind: 'other' } | { kind: 'timeout' }

/** Any HTTP status and content type count, including empty 401/404 responses. */
export async function probeHttpServer(port: number, address = '127.0.0.1'): Promise<ProbeResult> {
  const http = await probe('http', port, address)
  return http.kind === 'other' ? probe('https', port, address) : http
}

export function probeServerUrl(url: URL): Promise<ProbeResult> {
  const protocol = url.protocol === 'https:' ? 'https' : 'http'
  const port = Number(url.port) || (protocol === 'https' ? 443 : 80)
  const address = url.hostname.replace(/^\[|\]$/g, '')
  return probe(protocol, port, address, url.pathname + url.search)
}

function probe(protocol: 'http' | 'https', port: number, address: string, path = '/'): Promise<ProbeResult> {
  return new Promise((resolve) => {
    let settled = false
    let received: ProbeResult | null = null
    const finish = (result: ProbeResult) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(result)
      request.destroy()
    }
    const request = (protocol === 'http' ? httpRequest : httpsRequest)({
      hostname: address, port, path, method: 'GET',
      // Local development certificates are often self-signed. This request never leaves the host.
      rejectUnauthorized: false,
      headers: { accept: '*/*' },
    }, (response) => {
      const contentType = response.headers['content-type'] ?? null
      const result: ProbeResult = { kind: 'http', protocol, response: { protocol, statusCode: response.statusCode ?? 200, contentType, pageTitle: null } }
      received = result
      if (!contentType?.includes('text/html')) { finish(result); return }
      let body = ''
      response.on('data', (chunk: Buffer) => {
        body += chunk.toString('utf8').slice(0, MAX_TITLE_BYTES - body.length)
        const title = /<title[^>]*>([^<]{1,120})<\/title>/i.exec(body)?.[1].trim()
        if (title && result.response) result.response.pageTitle = title
        if (title || body.length >= MAX_TITLE_BYTES) finish(result)
      })
      response.on('end', () => finish(result))
      response.on('error', () => finish(result))
    })
    const timer = setTimeout(() => finish(received ?? { kind: 'timeout' }), PROBE_TIMEOUT_MS)
    request.on('error', () => finish({ kind: 'other' }))
    request.end()
  })
}

