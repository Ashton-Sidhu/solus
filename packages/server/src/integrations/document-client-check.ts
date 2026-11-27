import { createLogger } from '../logger'

const log = createLogger('integrations', 'document-client-check.ts')

/**
 * Whether an authorization server accepts Solus's Client ID Metadata Document
 * as the client (docs/plans/mcp-oauth-callback.md). A server can advertise
 * `client_id_metadata_document_supported` and still take documents only from
 * domains it trusts: Lovable, Descope, Deel, and others refuse `solus.sh`. They
 * refuse on their own page in the person's browser and never return to the
 * callback, so Solus cannot fall back after the browser opens.
 *
 * The host therefore asks first: one request to the authorization URL the
 * browser would open, with no cookies and no redirect followed. A server
 * checks the client before the login, so its answer is the browser's answer.
 * Only a clear refusal changes the sign-in; an unclear answer keeps the
 * document, as before this check. A clear answer is kept a day for each issuer
 * and callback, so a server that later trusts Solus gets the document again.
 */

export type DocumentClientAnswer = 'accepted' | 'refused' | 'unclear'

const TIMEOUT_MS = 5_000
const KEEP_MS = 24 * 60 * 60 * 1000
/** The errors that name the client, when the server returns to the callback. Another error (a scope, for example) is not about the client. */
const CLIENT_ERRORS = new Set(['invalid_client', 'unauthorized_client'])

/** The server's answer to the authorization URL, from its status and the place it sends the browser. */
export function documentClientAnswer(status: number, location: string | null, authorizationUrl: string, redirectUri: string): DocumentClientAnswer {
  if (status >= 200 && status < 300) return 'accepted'
  // Lovable answers 400 "Client not supported"; others 401 invalid_client.
  if (status === 400 || status === 401) return 'refused'
  if (status < 300 || status >= 400 || !location || !URL.canParse(location, authorizationUrl)) return 'unclear'
  const target = new URL(location, authorizationUrl)
  const callback = new URL(redirectUri)
  if (target.origin === callback.origin && target.pathname === callback.pathname) {
    const error = target.searchParams.get('error')
    if (error === null) return 'accepted'
    return CLIENT_ERRORS.has(error) ? 'refused' : 'unclear'
  }
  // An error page of the server (Descope `/login/error?error=invalid_client`, tray.ai `/oauth2/error?error_code=…`).
  const errorPage = target.searchParams.has('error') || target.searchParams.has('error_code') || target.pathname.split('/').includes('error')
  return errorPage ? 'refused' : 'accepted'
}

export class DocumentClientCheck {
  private readonly answers = new Map<string, { refused: boolean; at: number }>()

  constructor(private readonly deps: { fetch: typeof fetch; now: () => number }) {}

  /** Whether the server at `issuer` refuses the document for this authorization URL. Never throws; an unclear answer is not a refusal. */
  async refuses(issuer: string, authorizationUrl: string, redirectUri: string): Promise<boolean> {
    const key = `${issuer} ${redirectUri}`
    const kept = this.answers.get(key)
    if (kept && this.deps.now() - kept.at < KEEP_MS) return kept.refused
    const answer = await this.ask(authorizationUrl, redirectUri)
    log.info('client_metadata_document_checked', { issuer, answer })
    if (answer === 'unclear') return false
    this.answers.set(key, { refused: answer === 'refused', at: this.deps.now() })
    return answer === 'refused'
  }

  private async ask(authorizationUrl: string, redirectUri: string): Promise<DocumentClientAnswer> {
    try {
      const response = await this.deps.fetch(authorizationUrl, {
        redirect: 'manual',
        signal: AbortSignal.timeout(TIMEOUT_MS),
        headers: { accept: 'text/html,application/json;q=0.9,*/*;q=0.8' },
      })
      await response.body?.cancel().catch(() => undefined)
      return documentClientAnswer(response.status, response.headers.get('location'), authorizationUrl, redirectUri)
    } catch (error) {
      log.warn('client_metadata_document_check_failed', { error: error instanceof Error ? error.message : String(error) })
      return 'unclear'
    }
  }
}
