// Bundled OAuth client ID for Solus desktop and standalone server builds.
// Set SOLUS_GOOGLE_CLIENT_ID at build time; production embeds the real ID.
export const GOOGLE_CLIENT_ID = process.env.SOLUS_GOOGLE_CLIENT_ID ?? ''
