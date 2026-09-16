import { createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes, sign, type KeyObject } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { z } from 'zod'
import {
  HOST_GRANT_TTL_SECONDS,
  type EnrollHostResponse,
  type HostGrantClaims,
  type HostKind,
  type HostLinkResponse,
} from '@solus/contracts/uplink'
import type { Persona } from './personas'

const addressSchema = z.object({ port: z.number().int().positive() })

/**
 * The Lab's control plane in miniature (plan §8.1): one ES256 key, a JWKS endpoint on
 * loopback, and a mint that turns a persona into the grant the real cloud would sign.
 * The host trusts it because its link record names this issuer; nothing on the host
 * changes for the Lab.
 *
 * For a managed host it also plays the provisioner (docs/plans/managed-hosts.md §2):
 * `issueManagedLink` is what the real cloud puts in the machine's environment, the
 * same link record and tokens enrollment answers with. That record is then served
 * back at `GET /v1/hosts/:id/link` under the host token, so a rebooted host passes
 * its generation check exactly as it would against the real directory.
 */

function base64Url(value: string | Buffer): string {
  return Buffer.from(value).toString('base64url')
}

interface IssuedLink {
  hostToken: string
  link: HostLinkResponse
}

/** Everything the issuer answers with. */
type IssuerReply =
  | { keys: Array<JsonWebKey & { kid: string }> }
  | HostLinkResponse
  | { error: string; message?: string }

function sendJson(response: ServerResponse, status: number, body: IssuerReply): void {
  response.statusCode = status
  response.setHeader('content-type', 'application/json')
  response.end(JSON.stringify(body))
}

export interface MintOptions {
  hostId: string
  hostKind: HostKind
  hostOwnerUserId?: string
  /** Seconds; defaults to the full grant TTL. */
  ttlSeconds?: number
}

export class LabIssuer {
  readonly kid = 'lab-k1'
  private readonly privateKey: KeyObject
  private readonly jwk: JsonWebKey & { kid: string }
  private server: Server | null = null
  private port = 0
  private minted = 0
  private readonly links = new Map<string, IssuedLink>()

  /**
   * A fresh key and a free port by default. A proof that reboots a host against the
   * same persisted link record passes the key and port back in, because the real
   * control plane's key and origin do not change between a host's boots.
   */
  constructor(options: { privateKeyJwk?: JsonWebKey; port?: number } = {}) {
    if (options.privateKeyJwk) {
      this.privateKey = createPrivateKey({ key: options.privateKeyJwk, format: 'jwk' })
      const publicKey = createPublicKey(this.privateKey)
      this.jwk = { ...publicKey.export({ format: 'jwk' }), kid: this.kid, alg: 'ES256', use: 'sig' }
    } else {
      const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' })
      this.privateKey = privateKey
      this.jwk = { ...publicKey.export({ format: 'jwk' }), kid: this.kid, alg: 'ES256', use: 'sig' }
    }
    this.port = options.port ?? 0
  }

  /** The signing key as a JWK, for a proof that must present the same issuer after a reboot. */
  exportPrivateKeyJwk(): JsonWebKey {
    return this.privateKey.export({ format: 'jwk' })
  }

  get issuer(): string {
    return `http://127.0.0.1:${this.port}`
  }

  get jwksUrl(): string {
    return `${this.issuer}/jwks`
  }

  async start(): Promise<void> {
    if (this.server) return
    this.server = createServer((request, response) => {
      void this.handle(request, response).catch((error) => {
        sendJson(response, 500, { error: 'lab_issuer_failed', message: error instanceof Error ? error.message : String(error) })
      })
    })
    await new Promise<void>((resolve) => this.server!.listen(this.port, '127.0.0.1', resolve))
    const address = addressSchema.safeParse(this.server.address())
    this.port = address.success ? address.data.port : 0
  }

  async stop(): Promise<void> {
    const server = this.server
    this.server = null
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()))
  }

  /**
   * What the provisioner puts in a managed machine's environment (`SOLUS_MANAGED_LINK`):
   * the finished enrollment. A later generation supersedes an earlier one, as a
   * recreated machine's would.
   */
  issueManagedLink(hostId: string, proxiedPort: number, connectionGeneration = 1): EnrollHostResponse {
    const hostToken = `sht_lab_${randomBytes(18).toString('base64url')}`
    const link: HostLinkResponse = {
      hostId,
      desired: 'linked',
      connectionGeneration,
      hostname: `h-${hostId}.lab.invalid`,
      proxiedPort,
    }
    this.links.set(hostId, { hostToken, link })
    return {
      link: {
        hostId,
        issuer: this.issuer,
        jwksUrl: this.jwksUrl,
        directoryUrl: this.issuer,
        hostname: link.hostname,
        proxiedPort,
        connectionGeneration,
      },
      // The Lab runs no tunnel; the host's connector gets a token it can never use.
      connectorToken: 'lab-connector-token',
      hostToken,
    }
  }

  /** The link record the issuer handed a managed host, or null before one was issued. */
  issuedLink(hostId: string): HostLinkResponse | null {
    return this.links.get(hostId)?.link ?? null
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? '/', this.issuer)
    if (url.pathname === '/jwks') {
      sendJson(response, 200, { keys: [this.jwk] })
      return
    }
    const linkMatch = /^\/v1\/hosts\/([^/]+)\/link$/.exec(url.pathname)
    if (linkMatch) {
      const issued = this.links.get(linkMatch[1]!)
      const presented = request.headers.authorization?.replace(/^Bearer\s+/i, '')
      if (issued && presented === issued.hostToken) {
        if (request.method === 'DELETE') {
          this.links.delete(linkMatch[1]!)
          response.statusCode = 204
          response.end()
          return
        }
        sendJson(response, 200, issued.link)
        return
      }
      // A host the Lab never issued a link to (the hand-written record) gets 404:
      // "unknown", which keeps its link. A wrong token on a bootstrapped host is 401:
      // superseded, exactly what the real directory answers.
      sendJson(response, issued ? 401 : 404, { error: issued ? 'invalid_host_token' : 'host_not_found' })
      return
    }
    response.statusCode = 404
    response.end()
  }

  /** One grant per dial, exactly as the cloud would mint it for this persona. */
  mint(persona: Persona, options: MintOptions): string {
    const nowSeconds = Math.floor(Date.now() / 1000)
    this.minted += 1
    const base = {
      iss: this.issuer,
      aud: options.hostId,
      jti: `lab-${this.minted}-${nowSeconds}`,
      iat: nowSeconds,
      exp: nowSeconds + (options.ttlSeconds ?? HOST_GRANT_TTL_SECONDS),
      hostKind: options.hostKind,
      displayName: persona.displayName,
    }
    let claims: HostGrantClaims
    switch (persona.kind) {
      case 'host-owner':
        claims = { ...base, sub: `user:${persona.userId}`, deviceId: `${persona.id}-session`, access: 'owner', hostOwnerUserId: persona.userId }
        break
      case 'org-member':
        claims = {
          ...base,
          sub: `user:${persona.userId}`,
          deviceId: `${persona.id}-session`,
          access: 'org-member',
          organizationId: persona.organizationId,
          organizationRole: persona.organizationRole,
          teamIds: persona.teamIds,
        }
        if (options.hostOwnerUserId) claims.hostOwnerUserId = options.hostOwnerUserId
        break
      case 'guest':
        claims = { ...base, sub: `guest:${persona.guestId}`, deviceId: persona.guestId, access: 'guest' }
        break
    }
    const header = base64Url(JSON.stringify({ alg: 'ES256', kid: this.kid, typ: 'JWT' }))
    const body = base64Url(JSON.stringify(claims))
    const signature = sign('sha256', Buffer.from(`${header}.${body}`), { key: this.privateKey, dsaEncoding: 'ieee-p1363' })
    return `${header}.${body}.${base64Url(signature)}`
  }
}
