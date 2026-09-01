// Bundled OAuth client ID for Solus desktop and standalone server builds.
// Set SOLUS_ATLASSIAN_CLIENT_ID at build time; production embeds the real ID.
export const ATLASSIAN_CLIENT_ID = process.env.SOLUS_ATLASSIAN_CLIENT_ID ?? ''
