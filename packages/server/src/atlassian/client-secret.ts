// Bundled OAuth client secret for Solus desktop and standalone server builds.
// Atlassian has no public-client mode: `token_endpoint_auth_methods_supported`
// on the 3LO server offers only `client_secret_basic` and `client_secret_post`,
// so the secret is required on token exchange and refresh even with PKCE. Like
// the Google one beside it, it is non-confidential and shipped with the binary.
// Set SOLUS_ATLASSIAN_CLIENT_SECRET at build time; production embeds the value.
export const ATLASSIAN_CLIENT_SECRET = process.env.SOLUS_ATLASSIAN_CLIENT_SECRET ?? ''
