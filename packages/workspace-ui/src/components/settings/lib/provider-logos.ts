/**
 * Brand marks for the accounts on the Providers page.
 *
 * GitHub publishes a monochrome mark, so the `simple-icons:` glyph is used and
 * inherits the current text colour — it holds in both themes and on a filled
 * button, which the fixed-fill `logos:` variant does not. Cloudflare, Google and
 * Atlassian each own a colour, so they keep the full-colour `logos:` mark.
 *
 * Google is marked by Drive and Atlassian by the corporate mark rather than Jira
 * or Confluence: one grant covers the whole site, so a single product's mark
 * would under-describe what the user connected.
 */
export const PROVIDER_LOGOS = {
  github: 'simple-icons:github',
  google: 'logos:google-drive',
  confluence: 'logos:confluence',
  cloudflare: 'logos:cloudflare-icon',
  atlassian: 'logos:atlassian',
} as const

/** Registered in the build-time Iconify subset so these render offline. */
export const PROVIDER_LOGO_NAMES: string[] = Object.values(PROVIDER_LOGOS)
