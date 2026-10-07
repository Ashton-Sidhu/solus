/**
 * Whether a terminal error is the provider refusing the turn's login: an expired,
 * revoked, or missing credential. Codex says "unexpected status 401 Unauthorized:
 * Missing bearer …"; Claude says "Invalid API key · Please run /login", "OAuth
 * token has expired", or "API Error: 401 … authentication_error".
 */
export function isAuthFailureMessage(message: string): boolean {
  return /\b401 unauthori[sz]ed\b|api error:?\s*401\b|authentication_(?:error|failed)|invalid api key|please run \/login|not logged in|oauth token (?:has expired|revoked)|missing bearer/i.test(message)
}
