import { createHash, createHmac } from 'node:crypto'
import { SESSION_CODE_CHECKSUM_HEADER } from '@solus/contracts/session-repositories'
import { encodeObjectKey, encodeUriPart, OBJECT_URL_TTL_SECONDS, type ObjectStore } from './object-store'

/** The variables that name the R2 bucket of session code bundles. The account is the Artifacts account. */
export interface R2Environment {
  SOLUS_ARTIFACTS_ACCOUNT_ID?: string
  SOLUS_SESSION_R2_BUCKET?: string
  SOLUS_R2_ACCESS_KEY_ID?: string
  SOLUS_R2_SECRET_ACCESS_KEY?: string
}

export interface S3PresignRequest {
  method: 'GET' | 'PUT'
  host: string
  /** The path, already encoded with `encodeUriPart` for each segment. */
  path: string
  region: string
  accessKeyId: string
  secretAccessKey: string
  now: Date
  expiresSeconds: number
  /** Headers that the request must send with these values. `host` is always signed. */
  headers: readonly (readonly [name: string, value: string])[]
}

const hmac = (key: Buffer | string, text: string) => createHmac('sha256', key).update(text, 'utf8').digest()

/** An S3 Signature Version 4 URL with the signature in the query (AWS "Authenticating Requests: Using Query Parameters"). */
export function presignS3Url(request: S3PresignRequest): string {
  const amzDate = request.now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '')
  const day = amzDate.slice(0, 8)
  const credentialScope = `${day}/${request.region}/s3/aws4_request`
  const headers = [['host', request.host] as const, ...request.headers.map(([name, value]) => [name.toLowerCase(), value.trim()] as const)]
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
  const signedHeaders = headers.map(([name]) => name).join(';')
  const query = [
    ['X-Amz-Algorithm', 'AWS4-HMAC-SHA256'],
    ['X-Amz-Credential', `${request.accessKeyId}/${credentialScope}`],
    ['X-Amz-Date', amzDate],
    ['X-Amz-Expires', String(request.expiresSeconds)],
    ['X-Amz-SignedHeaders', signedHeaders],
  ].map(([name, value]) => `${encodeUriPart(name!)}=${encodeUriPart(value!)}`).sort().join('&')
  const canonicalRequest = [
    request.method, request.path, query,
    headers.map(([name, value]) => `${name}:${value}\n`).join(''),
    signedHeaders, 'UNSIGNED-PAYLOAD',
  ].join('\n')
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, credentialScope, createHash('sha256').update(canonicalRequest, 'utf8').digest('hex')].join('\n')
  const signingKey = hmac(hmac(hmac(hmac(`AWS4${request.secretAccessKey}`, day), request.region), 's3'), 'aws4_request')
  return `https://${request.host}${request.path}?${query}&X-Amz-Signature=${hmac(signingKey, stringToSign).toString('hex')}`
}

/**
 * One R2 bucket. The keys stay in the Solus API; a host gets one signed URL for one object.
 * A write URL signs `content-length` and the SHA-256 checksum header, so the uploader
 * must send both with those values, and R2 refuses other bytes.
 */
export class R2ObjectStore implements ObjectStore {
  readonly storageScope: string
  private readonly host: string
  constructor(
    accountId: string,
    private readonly bucket: string,
    private readonly accessKeyId: string,
    private readonly secretAccessKey: string,
    private readonly now: () => Date = () => new Date(),
  ) {
    if (!/^[a-f0-9]{32}$/.test(accountId) || !/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(bucket) || !accessKeyId || !secretAccessKey) throw new Error('Invalid R2 account, bucket or server credential.')
    this.host = `${accountId}.r2.cloudflarestorage.com`
    this.storageScope = `r2://${accountId}/${bucket}`
  }

  /** The bucket that the environment names. The error names each variable that is missing. */
  static fromEnvironment(env: R2Environment): R2ObjectStore {
    const required = ['SOLUS_ARTIFACTS_ACCOUNT_ID', 'SOLUS_SESSION_R2_BUCKET', 'SOLUS_R2_ACCESS_KEY_ID', 'SOLUS_R2_SECRET_ACCESS_KEY'] as const
    const missing = required.filter(name => !env[name])
    if (missing.length) throw new Error(`Session code storage on R2 needs ${missing.join(', ')}.`)
    return new R2ObjectStore(env.SOLUS_ARTIFACTS_ACCOUNT_ID!, env.SOLUS_SESSION_R2_BUCKET!, env.SOLUS_R2_ACCESS_KEY_ID!, env.SOLUS_R2_SECRET_ACCESS_KEY!)
  }

  async signedUrl(key: string, access: 'read' | 'write', facts: { bytes: number; sha256: string }): Promise<string> {
    return presignS3Url({
      method: access === 'write' ? 'PUT' : 'GET',
      host: this.host,
      path: `/${this.bucket}/${encodeObjectKey(key)}`,
      region: 'auto',
      accessKeyId: this.accessKeyId,
      secretAccessKey: this.secretAccessKey,
      now: this.now(),
      expiresSeconds: OBJECT_URL_TTL_SECONDS,
      headers: access === 'write'
        ? [['content-length', String(facts.bytes)], [SESSION_CODE_CHECKSUM_HEADER, Buffer.from(facts.sha256, 'hex').toString('base64')]]
        : [],
    })
  }
}
