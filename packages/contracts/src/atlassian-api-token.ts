import { z } from 'zod'
import type { AtlassianApiTokenInput, AtlassianProduct } from './atlassian'

/**
 * An Atlassian API token a person pasted, checked with Atlassian, with the site it
 * reaches. One shape in the three places that hold it: a host's store, the cloud
 * vault's material, and the delivery the cloud sends a host.
 *
 * It acts as the person with all their permissions, and never expires or rotates
 * from Solus's side. A classic token is sent to the site hostname; a scoped token
 * only works through the `api.atlassian.com` gateway. Which one this token is, is
 * found once at connect (`apiBase`).
 */
export const atlassianApiTokenCredentialSchema = z.object({
  kind: z.literal('apiToken'),
  siteUrl: z.string(),
  cloudId: z.string(),
  siteName: z.string().optional(),
  products: z.array(z.enum(['confluence', 'jira'])),
  email: z.string(),
  apiToken: z.string(),
  apiBase: z.enum(['site', 'gateway']),
})
export type AtlassianApiTokenCredential = z.infer<typeof atlassianApiTokenCredentialSchema>

/** A refusal the person can act on: a wrong site, email, or token. */
export class AtlassianApiTokenError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'AtlassianApiTokenError'
  }
}

const PROBE_TIMEOUT_MS = 15_000
const PRODUCTS: AtlassianProduct[] = ['jira', 'confluence']

/** One cheap read per product, made the way every later call will be made. */
const PRODUCT_PROBES = {
  jira: '/rest/api/3/myself',
  confluence: '/wiki/api/v2/spaces?limit=1',
} satisfies Record<AtlassianProduct, string>

const tenantInfoSchema = z.object({ cloudId: z.string().min(1) })

/**
 * `acme`, `acme.atlassian.net`, or a link copied from any page on the site — all
 * name the same origin. Only https: the token is sent to it.
 */
export function atlassianSiteOriginOf(input: string): string {
  const trimmed = input.trim()
  if (!trimmed) throw new AtlassianApiTokenError('Enter your Atlassian site, for example acme.atlassian.net.')
  const withHost = trimmed.includes('.') || trimmed.includes('/') ? trimmed : `${trimmed}.atlassian.net`
  let url: URL
  try {
    url = new URL(/^[a-z]+:\/\//i.test(withHost) ? withHost : `https://${withHost}`)
  } catch {
    throw new AtlassianApiTokenError(`"${trimmed}" is not an Atlassian site address.`)
  }
  if (url.protocol !== 'https:') throw new AtlassianApiTokenError('The Atlassian site address must use https.')
  return url.origin
}

/** The `Basic` header for an API token. UTF-8 first, since `btoa` takes only Latin-1. */
export function atlassianApiTokenAuthorization(credential: Pick<AtlassianApiTokenCredential, 'email' | 'apiToken'>): string {
  const bytes = new TextEncoder().encode(`${credential.email}:${credential.apiToken}`)
  return `Basic ${btoa(String.fromCharCode(...bytes))}`
}

/**
 * Where a product's REST paths start. Product paths are written as the site serves
 * them (`/rest/api/3/...`, `/wiki/api/v2/...`), so the site hostname and the
 * gateway prefix take the same path.
 */
export function atlassianApiTokenBaseUrl(
  credential: Pick<AtlassianApiTokenCredential, 'apiBase' | 'siteUrl' | 'cloudId'>,
  product: AtlassianProduct,
): string {
  return credential.apiBase === 'site' ? credential.siteUrl : `https://api.atlassian.com/ex/${product}/${credential.cloudId}`
}

export interface AtlassianApiTokenCheck {
  fetch: typeof fetch
  /** The cloud's guard against a site that is not a public address. */
  allowsSite?: (origin: string) => boolean
}

/**
 * Checks a pasted token with Atlassian and answers the credential to keep, or
 * throws `AtlassianApiTokenError` with the reason. Nothing is kept here.
 *
 * The site's `cloudId` comes from its public `tenant_info`, so a wrong address
 * fails before the token is sent. Nothing in a token says whether it is classic or
 * scoped, so the site is tried first, then the gateway, and the one that answers
 * is kept with the products it reaches.
 */
export async function checkAtlassianApiToken(
  input: AtlassianApiTokenInput,
  check: AtlassianApiTokenCheck,
): Promise<AtlassianApiTokenCredential> {
  const siteUrl = atlassianSiteOriginOf(input.siteUrl)
  if (check.allowsSite && !check.allowsSite(siteUrl)) {
    throw new AtlassianApiTokenError(`${siteUrl} is not an Atlassian Cloud site Solus can reach.`)
  }
  const email = input.email.trim()
  const apiToken = input.apiToken.trim()
  if (!email || !apiToken) throw new AtlassianApiTokenError('Enter the email of your Atlassian account and an API token.')

  const tenant = await check.fetch(`${siteUrl}/_edge/tenant_info`, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) })
    .catch(() => null)
  const parsed = tenant?.ok ? tenantInfoSchema.safeParse(await tenant.json().catch(() => null)) : null
  if (!parsed?.success) throw new AtlassianApiTokenError(`Solus could not find an Atlassian Cloud site at ${siteUrl}.`)
  const cloudId = parsed.data.cloudId

  for (const apiBase of ['site', 'gateway'] as const) {
    const candidate: AtlassianApiTokenCredential = { kind: 'apiToken', siteUrl, cloudId, products: [], email, apiToken, apiBase }
    const reached = await Promise.all(PRODUCTS.map(async (product) => {
      const response = await check.fetch(`${atlassianApiTokenBaseUrl(candidate, product)}${PRODUCT_PROBES[product]}`, {
        headers: { authorization: atlassianApiTokenAuthorization(candidate), accept: 'application/json' },
        signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      }).catch(() => null)
      return response?.ok === true
    }))
    const products = PRODUCTS.filter((_, index) => reached[index])
    if (products.length > 0) return { ...candidate, products }
  }
  throw new AtlassianApiTokenError(`Atlassian did not accept this email and API token for ${siteUrl}.`)
}
