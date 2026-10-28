import type { AtlassianApiTokenInput } from '@solus/contracts/atlassian'
import {
  AtlassianApiTokenError,
  checkAtlassianApiToken,
  type AtlassianApiTokenCredential,
} from '@solus/contracts/atlassian-api-token'
import { createLogger } from '../logger'
import { usesAccountIntegration } from '../vault/vault'
import { persistCredential } from './token-store'

const log = createLogger('main', 'atlassian-api-token')

/**
 * Connects the site on this host with a token the user pasted, and keeps it
 * only once Atlassian has accepted it. A person whose connections live in their
 * account pastes it on the account website instead, which runs the same check.
 */
export async function connectWithApiToken(input: AtlassianApiTokenInput): Promise<AtlassianApiTokenCredential> {
  if (usesAccountIntegration()) throw new AtlassianApiTokenError('Connect Atlassian on your account website.')
  const credential = await checkAtlassianApiToken(input, { fetch })
  await persistCredential(credential)
  log.info('atlassian_api_token_connected', { cloudId: credential.cloudId, apiBase: credential.apiBase, products: credential.products })
  return credential
}
