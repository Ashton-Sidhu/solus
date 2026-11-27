/**
 * Solus's one loopback callback for MCP sign-ins (docs/plans/mcp-oauth-callback.md).
 * It is the client's public identity: vendor
 * allowlists, organization allowlists (Atlassian's), Solus's Client ID Metadata
 * Document, and the OAuth apps owners create all match it as an exact string.
 * So it is a constant, never derived from the origin a client reached the host
 * on. `/callback` on a loopback IP is the shape native clients use (RFC 8252
 * §7.3), and the one servers that allow "the CLI clients" accept.
 *
 * The host listens on this port only while a sign-in from a browser on the
 * host waits for it.
 */
export const INTEGRATION_OAUTH_LOOPBACK_PORT = 51790
export const INTEGRATION_OAUTH_LOOPBACK_PATH = '/callback'
export const INTEGRATION_OAUTH_LOOPBACK_URL = `http://127.0.0.1:${INTEGRATION_OAUTH_LOOPBACK_PORT}${INTEGRATION_OAUTH_LOOPBACK_PATH}`
