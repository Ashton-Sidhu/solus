import { z } from 'zod'
import type { CatalogCategoryId } from '@solus/contracts/integration-types'
import { vendorJson, type SolusServerDefinition, type SolusServerTool, type SolusToolContext } from './solus-server'

/**
 * What every Google product's Solus MCP server shares
 * (docs/plans/mcp-integrations.md §13.6): Google's sign-in through Solus's
 * Google app (§13.1), and the account's email as the connection label, so
 * several accounts (§13.3) read the same in every Google server. One server
 * per product, so each sign-in asks only for that product's scopes.
 */

/** Google returns a refresh token only for offline access, and again only on consent; the chooser lets "Add another account" pick another account. */
const GOOGLE_SIGN_IN_PARAMS = { access_type: 'offline', prompt: 'select_account consent' }

/** Every Google server also asks who signed in, for the label. */
const IDENTITY_SCOPES = ['openid', 'email'] as const

const USERINFO = 'https://openidconnect.googleapis.com/v1/userinfo'

const userinfoSchema = z.object({ email: z.string() })

export interface GoogleProductSpec {
  /** The address id: `solus:<id>`. */
  id: string
  name: string
  description: string
  domain: string
  icon: string
  categories: CatalogCategoryId[]
  /** The product's API hosts; the sign-in's userinfo host is added. */
  hosts: string[]
  /** The product's own scopes, the fewest its tools need. */
  scopes: readonly string[]
  tools: SolusServerTool[]
}

/** One Google product as a Solus MCP server. */
export class GoogleSolusServer implements SolusServerDefinition {
  readonly id: string
  readonly name: string
  readonly description: string
  readonly domain: string
  readonly icon: string
  readonly categories: CatalogCategoryId[]
  readonly hosts: string[]
  readonly auth: SolusServerDefinition['auth']
  readonly tools: SolusServerTool[]

  constructor(spec: GoogleProductSpec) {
    this.id = spec.id
    this.name = spec.name
    this.description = spec.description
    this.domain = spec.domain
    this.icon = spec.icon
    this.categories = spec.categories
    this.hosts = [...spec.hosts, new URL(USERINFO).hostname]
    this.auth = {
      discover: 'https://accounts.google.com/.well-known/openid-configuration',
      sign: { scopes: [...IDENTITY_SCOPES, ...spec.scopes], params: GOOGLE_SIGN_IN_PARAMS },
      sendsResource: false,
      firstParty: 'google',
    }
    this.tools = spec.tools
  }

  /** The Google account the token belongs to, by its email. */
  async identify({ fetch }: SolusToolContext): Promise<string | null> {
    const user = userinfoSchema.safeParse(await vendorJson(await fetch(USERINFO)))
    return user.success ? user.data.email : null
  }
}
