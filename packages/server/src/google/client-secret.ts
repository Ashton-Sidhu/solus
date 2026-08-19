// Bundled OAuth client secret for the Solus desktop app.
// Google "Desktop app" clients require the client_secret on token exchange/refresh
// even with PKCE; it is non-confidential and shipped with the binary.
// Set SOLUS_GOOGLE_CLIENT_SECRET at build time; production embeds the real value.
export const GOOGLE_CLIENT_SECRET = process.env.SOLUS_GOOGLE_CLIENT_SECRET ?? ''
