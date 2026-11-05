import { isIP } from 'net'
import { hostname } from 'os'
import { z } from 'zod'

/** The two headers that say who made a request: one of each, or the request is refused. */
const requestSourceSchema = z.object({ host: z.string().min(1), origin: z.string().optional() })

/**
 * Whether a web page on another site could have made this request
 * (docs/plans/fast-secure-startup.md decision 4). A page the person visits runs on
 * this machine, so network position proves nothing for it: a request with no
 * credential acts as the owner only when this answers false.
 *
 * - `Host` must name this machine: an IP literal, `localhost`, or this machine's own
 *   name. A DNS-rebound name (an attacker's domain pointed at 127.0.0.1) fails here.
 * - `Origin`, when the browser sends one, must be this same host: the host's own
 *   page. A page on another site fails here. A client that is no web page (the CLI,
 *   an agent tool, a native app) sends no `Origin`.
 */
export function couldBeForgedByWebPage(headers: { host?: string | string[]; origin?: string | string[] }): boolean {
  const source = requestSourceSchema.safeParse({ host: headers.host, origin: headers.origin })
  if (!source.success) return true
  const host = source.data.host.toLowerCase()
  try {
    if (!namesThisMachine(new URL(`http://${host}`).hostname)) return true
    return source.data.origin !== undefined && new URL(source.data.origin).host.toLowerCase() !== host
  } catch {
    return true
  }
}

function namesThisMachine(name: string): boolean {
  if (name === 'localhost' || isIP(name.replace(/^\[|\]$/g, '')) !== 0) return true
  const machine = hostname().toLowerCase()
  return name === machine || name === `${machine.replace(/\.local$/, '')}.local`
}
