// Bundled OAuth App client ID for Solus desktop and standalone server builds.
// Set SOLUS_GITHUB_CLIENT_ID at build time; production embeds the real ID.
//
// Device flow needs no client secret, so — unlike google/ — there is
// deliberately no client-secret.ts here.
export const GITHUB_CLIENT_ID = process.env.SOLUS_GITHUB_CLIENT_ID ?? ''
