import type { SolusServer } from '../server'
import { verifyCloudflareToken, type CloudflareAccount } from '../../cloudflare/api'
import { clearToken, loadToken, persistToken } from '../../cloudflare/token-store'
import { EncryptionUnavailableError } from '../../providers/github/token-store'

type CloudflareConnectResult =
  | { ok: true; accountName?: string }
  | { ok: false; kind: 'invalid' | 'network' | 'accounts-forbidden' | 'encryption-unavailable'; error: string }
  | { ok: false; kind: 'choose-account'; accounts: CloudflareAccount[] }

export function registerCloudflareHandlers(server: SolusServer): void {
  server.register('cloudflareStatus', () => {
    if (process.env.CLOUDFLARE_API_TOKEN) {
      return {
        connected: true,
        source: 'env' as const,
        ...(process.env.CLOUDFLARE_ACCOUNT_ID ? { accountId: process.env.CLOUDFLARE_ACCOUNT_ID } : {}),
      }
    }
    const token = loadToken()
    if (!token) return { connected: false }
    return {
      connected: true,
      source: 'stored' as const,
      accountId: token.accountId,
      ...(token.accountName ? { accountName: token.accountName } : {}),
      ...(token.expiresOn ? { expiresOn: token.expiresOn } : {}),
    }
  })

  server.register('cloudflareConnect', async (args): Promise<CloudflareConnectResult> => {
    const [input] = args as [{ apiToken?: unknown; accountId?: unknown }]
    const apiToken = typeof input?.apiToken === 'string' ? input.apiToken.trim() : ''
    const requestedAccountId = typeof input?.accountId === 'string' ? input.accountId.trim() : ''
    if (!apiToken) return { ok: false, kind: 'invalid', error: 'A Cloudflare API token is required.' }

    const verification = await verifyCloudflareToken(apiToken)
    if (verification.kind === 'invalid') return { ok: false, kind: 'invalid', error: 'The Cloudflare API token is invalid or inactive.' }
    if (verification.kind === 'network') return { ok: false, kind: 'network', error: 'Could not reach the Cloudflare API.' }
    if (verification.kind === 'accounts-forbidden') {
      if (!requestedAccountId) {
        return { ok: false, kind: 'accounts-forbidden', error: 'The token is valid but cannot list accounts. Enter an account ID manually.' }
      }
      try {
        persistToken({ apiToken, accountId: requestedAccountId })
        return { ok: true }
      } catch (error) {
        if (error instanceof EncryptionUnavailableError) {
          return { ok: false, kind: 'encryption-unavailable', error: error.message }
        }
        throw error
      }
    }

    const account = requestedAccountId
      ? verification.accounts.find((candidate) => candidate.id === requestedAccountId)
      : verification.accounts.length === 1 ? verification.accounts[0] : undefined
    if (!account) {
      return { ok: false, kind: 'choose-account', accounts: verification.accounts }
    }
    try {
      persistToken({ apiToken, accountId: account.id, accountName: account.name, expiresOn: verification.expiresOn })
      return { ok: true, ...(account.name ? { accountName: account.name } : {}) }
    } catch (error) {
      if (error instanceof EncryptionUnavailableError) {
        return { ok: false, kind: 'encryption-unavailable', error: error.message }
      }
      throw error
    }
  })

  server.register('cloudflareDisconnect', () => {
    clearToken()
  })
}
