// Bundled OAuth client ID for the Solus desktop app.
// Set SOLUS_GOOGLE_CLIENT_ID at build time; production embeds the real ID.
export const GOOGLE_CLIENT_ID = process.env.SOLUS_GOOGLE_CLIENT_ID ?? ''
