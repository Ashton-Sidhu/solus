import { beforeAll, describe, expect, mock, test } from 'bun:test'
import type { SecretStore } from '../../src/main/platform/secrets'

const records = new Map<string, unknown>()
let canSave = true
const store: SecretStore = {
  loadJson: <T>(key: string) => (records.get(key) as T | undefined) ?? null,
  saveJson: (key: string, _path: string, value: unknown) => { records.set(key, value) },
  remove: (key: string) => { records.delete(key) },
  canSave: () => canSave,
}

mock.module('../../src/main/platform/secrets', () => ({ secretStore: () => store }))

let clearToken: typeof import('../../src/main/cloudflare/token-store')['clearToken']
let loadToken: typeof import('../../src/main/cloudflare/token-store')['loadToken']
let persistToken: typeof import('../../src/main/cloudflare/token-store')['persistToken']
let EncryptionUnavailableError: typeof import('../../src/main/providers/github/token-store')['EncryptionUnavailableError']

beforeAll(async () => {
  ;({ clearToken, loadToken, persistToken } = await import('../../src/main/cloudflare/token-store'))
  ;({ EncryptionUnavailableError } = await import('../../src/main/providers/github/token-store'))
})

describe('Cloudflare token store', () => {
  test('round-trips a token through the secret store', () => {
    records.clear()
    persistToken({ apiToken: 'secret', accountId: 'account-1', accountName: 'Acme', expiresOn: 123 })
    expect(loadToken()).toEqual({ apiToken: 'secret', accountId: 'account-1', accountName: 'Acme', expiresOn: 123 })
  })

  test('clearing a missing token is a no-op', () => {
    records.clear()
    expect(clearToken).not.toThrow()
  })

  test('refuses to persist without encryption', () => {
    records.clear()
    canSave = false
    try {
      expect(() => persistToken({ apiToken: 'secret', accountId: 'account-1' })).toThrow(EncryptionUnavailableError)
      expect(loadToken()).toBeNull()
    } finally {
      canSave = true
    }
  })
})
