import { describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import {
  credentialRefSchema,
  deliverySchemaOf,
  refKeyOf,
  vaultConnectRequestSchema,
  vaultSaveKeyRequestSchema,
  vaultSeatWriteRequestSchema,
  vaultUploadRequestSchema,
  type CredentialRef,
} from '@solus/contracts/vault'

// docs/plans/cloud-vault.md §1, §2.3: the host and the cloud name a credential with
// one ref, and the cloud keys its table by `refKeyOf`. A key that differs between the
// two sides, or a delivery that the host's readers cannot parse, loses the credential.

describe('refKeyOf', () => {
  test('names each ref kind with one canonical string', async () => {
    expect(await refKeyOf({ kind: 'provider', provider: 'github' })).toBe('provider:github')
    expect(await refKeyOf({ kind: 'typesafe' })).toBe('typesafe')
    expect(await refKeyOf({ kind: 'seat', provider: 'claude-code' })).toBe('seat:claude-code')
  })

  test('keys an MCP server by the SHA-256 of its normalized URL, as the cloud has always keyed it', async () => {
    // The cloud's `serverKeyOf` hashed `new URL(serverUrl).href`; a different hash orphans every stored connection.
    const href = new URL('HTTPS://MCP.Example.test:443/mcp').href
    expect(href).toBe('https://mcp.example.test/mcp')
    const expected = `mcp:${createHash('sha256').update(href).digest('hex')}`
    expect(await refKeyOf({ kind: 'mcp', serverUrl: 'HTTPS://MCP.Example.test:443/mcp' })).toBe(expected)
    expect(await refKeyOf({ kind: 'mcp', serverUrl: 'https://mcp.example.test/mcp' })).toBe(expected)
    expect(await refKeyOf({ kind: 'mcp', serverUrl: 'https://mcp.example.test/other' })).not.toBe(expected)
  })
})

describe('credential refs', () => {
  test('accepts the four kinds and refuses anything else', () => {
    const refs: CredentialRef[] = [
      { kind: 'provider', provider: 'atlassian' },
      { kind: 'mcp', serverUrl: 'https://mcp.example.test/mcp' },
      { kind: 'typesafe' },
      { kind: 'seat', provider: 'codex' },
    ]
    for (const ref of refs) expect(credentialRefSchema.parse(ref)).toEqual(ref)
    // TypeSafe is its own kind in the cloud, not a provider.
    expect(credentialRefSchema.safeParse({ kind: 'provider', provider: 'typesafe' }).success).toBe(false)
    expect(credentialRefSchema.safeParse({ kind: 'mcp', serverUrl: 'not a url' }).success).toBe(false)
    // The host's integration id is not part of the account's ref.
    expect(credentialRefSchema.safeParse({ kind: 'mcp', serverUrl: 'https://a.test/mcp', integrationId: 'i' }).success).toBe(false)
  })
})

describe('deliveries', () => {
  test("a provider delivery has today's /v1/integrations shapes, so the host's provider readers keep parsing", () => {
    const github = { accessToken: 'gho', scope: 'repo,read:org', login: 'ada' }
    expect(deliverySchemaOf({ kind: 'provider', provider: 'github' }).parse(github)).toEqual(github)
    const google = { accessToken: 'ya29', refreshToken: '', expiresAt: 1, scopes: ['drive.file'] }
    expect(deliverySchemaOf({ kind: 'provider', provider: 'google' }).parse(google)).toEqual(google)
    const atlassian = { ...google, siteUrl: 'https://a.atlassian.net', cloudId: 'site-a', siteName: 'A', products: ['jira'] }
    expect(deliverySchemaOf({ kind: 'provider', provider: 'atlassian' }).parse(atlassian)).toEqual(atlassian)
    // A delivery never carries a refresh token.
    expect(deliverySchemaOf({ kind: 'provider', provider: 'google' }).safeParse({ ...google, refreshToken: 'r' }).success).toBe(false)
  })

  test('an MCP, TypeSafe, and seat delivery each have their own shape', () => {
    expect(deliverySchemaOf({ kind: 'mcp', serverUrl: 'https://a.test/mcp' }).parse({ authorization: 'Bearer t', expiresAt: null, label: null })).toBeTruthy()
    expect(deliverySchemaOf({ kind: 'typesafe' }).parse({ key: 'ts_key' })).toEqual({ key: 'ts_key' })
    expect(deliverySchemaOf({ kind: 'seat', provider: 'codex' }).parse({ file: '{"tokens":{}}', version: 3 })).toEqual({ file: '{"tokens":{}}', version: 3 })
    expect(deliverySchemaOf({ kind: 'seat', provider: 'codex' }).safeParse({ file: 'not json', version: 1 }).success).toBe(false)
  })
})

describe('requests', () => {
  const mcp = { kind: 'mcp', serverUrl: 'https://mcp.example.test/mcp' } as const

  test('an upload carries material that fits its ref', () => {
    expect(vaultUploadRequestSchema.safeParse({ ref: { kind: 'typesafe' }, material: { kind: 'key', key: 'k' }, expectedVersion: null }).success).toBe(true)
    expect(vaultUploadRequestSchema.safeParse({ ref: mcp, material: { kind: 'key', key: 'k', scheme: 'bearer' }, expectedVersion: 2, label: 'Ada' }).success).toBe(true)
    expect(vaultUploadRequestSchema.safeParse({ ref: { kind: 'seat', provider: 'claude-code' }, material: { kind: 'cli-login', file: '{}' }, expectedVersion: 1 }).success).toBe(true)
    // A seat takes only a login file; TypeSafe only a key.
    expect(vaultUploadRequestSchema.safeParse({ ref: { kind: 'seat', provider: 'claude-code' }, material: { kind: 'key', key: 'k' }, expectedVersion: null }).success).toBe(false)
    expect(vaultUploadRequestSchema.safeParse({ ref: { kind: 'typesafe' }, material: { kind: 'cli-login', file: '{}' }, expectedVersion: null }).success).toBe(false)
    // A provider ref parses, so the route can answer `not_uploadable` rather than `invalid_request`.
    expect(vaultUploadRequestSchema.safeParse({ ref: { kind: 'provider', provider: 'github' }, material: { kind: 'key', key: 'k' }, expectedVersion: null }).success).toBe(true)
    // An upload never carries a provider's refresh-token material.
    expect(vaultUploadRequestSchema.safeParse({ ref: mcp, material: { kind: 'oauth', accessToken: 'a', refreshToken: 'r', expiresAt: 1, scopes: [] }, expectedVersion: null }).success).toBe(false)
  })

  test('a pasted key is for TypeSafe or an MCP server only', () => {
    expect(vaultSaveKeyRequestSchema.safeParse({ ref: { kind: 'typesafe' }, key: 'k' }).success).toBe(true)
    expect(vaultSaveKeyRequestSchema.safeParse({ ref: mcp, key: 'k', scheme: 'basic' }).success).toBe(true)
    expect(vaultSaveKeyRequestSchema.safeParse({ ref: { kind: 'provider', provider: 'github' }, key: 'k' }).success).toBe(false)
    expect(vaultSaveKeyRequestSchema.safeParse({ ref: { kind: 'typesafe' }, key: '' }).success).toBe(false)
  })

  test('a connect names a ref, and an MCP server the profile does not name brings its auth', () => {
    expect(vaultConnectRequestSchema.parse({ ref: { kind: 'provider', provider: 'google' } })).toEqual({ ref: { kind: 'provider', provider: 'google' } })
    expect(vaultConnectRequestSchema.safeParse({ ref: mcp, auth: { kind: 'bearer', scheme: 'bearer' } }).success).toBe(true)
  })

  test('a host worker writes back seat refs only', () => {
    const write = { organizationId: 'org', ref: { kind: 'seat', provider: 'codex' }, file: '{}', expectedVersion: 4 }
    expect(vaultSeatWriteRequestSchema.safeParse(write).success).toBe(true)
    expect(vaultSeatWriteRequestSchema.safeParse({ ...write, ref: { kind: 'typesafe' } }).success).toBe(false)
  })
})
