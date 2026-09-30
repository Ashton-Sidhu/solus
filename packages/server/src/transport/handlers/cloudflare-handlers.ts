import type { SolusServer } from '../server'
import { verifyCloudflareToken, type CloudflareAccount } from '../../cloudflare/api'
import { clearToken, loadToken, persistToken } from '../../cloudflare/token-store'
import { EncryptionUnavailableError } from '../../providers/github/token-store'
import { z } from 'zod'

type CloudflareConnectResult =
  | { ok: true; accountName?: string }
  | { ok: false; kind: 'invalid' | 'network' | 'accounts-forbidden' | 'encryption-unavailable'; error: string }
  | { ok: false; kind: 'choose-account'; accounts: CloudflareAccount[] }

const cloudflareConnectSchema = z.object({
  apiToken: z.string(),
  accountId: z.string().optional(),
}).strict()

export function registerCloudflareHandlers(server: SolusServer): void {
  server.register('cloudflareStatus', () => {
    if (process.env.CLOUDFLARE_API_TOKEN) {
      const status = {
        connected: true,
        source: 'env' as const,
      }
      if (process.env.CLOUDFLARE_ACCOUNT_ID) Object.assign(status, { accountId: process.env.CLOUDFLARE_ACCOUNT_ID })
      return status
    }
    const token = loadToken()
    if (!token) return { connected: false }
    const status = {
      connected: true,
      source: 'stored' as const,
      accountId: token.accountId,
    }
    if (token.accountName) Object.assign(status, { accountName: token.accountName })
    if (token.expiresOn) Object.assign(status, { expiresOn: token.expiresOn })
    return status
  })

  server.register('cloudflareConnect', async (args): Promise<CloudflareConnectResult> => {
    const [input] = args
    const request = cloudflareConnectSchema.parse(input)
    const apiToken = request.apiToken.trim()
    const requestedAccountId = request.accountId?.trim() ?? ''
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
      const storedToken = { apiToken, accountId: account.id, accountName: account.name }
      if (verification.expiresOn) Object.assign(storedToken, { expiresOn: verification.expiresOn })
      persistToken(storedToken)
      const result: CloudflareConnectResult = { ok: true }
      if (account.name) result.accountName = account.name
      return result
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
