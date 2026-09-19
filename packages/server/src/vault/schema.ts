import { bigint, defineTable, integer, text } from '../db/schema/define-table'

/**
 * The credential vault (docs/plans/cloud-service-model.md §5): one connection
 * per person per provider, made once on the workspace service and leased by
 * every runner for that person only. The material is encrypted with the
 * service key before it is stored; nothing here is readable without it.
 *
 * The vault is keyed by the person, not the organization: a login is theirs
 * wherever they work. Which organizations may lease it is answered by
 * `organization_members`, which the service fills as members arrive.
 */

export const credentialVault = defineTable('credential_vault', {
  user_id: text({ notNull: true }),
  /** `claude-code` | `codex` today; the column is open for the org integrations. */
  provider: text({ notNull: true }),
  /** How the material was made: a relayed CLI login, or a pasted token. */
  method: text({ notNull: true }),
  /** `v1.<base64 iv>.<base64 ciphertext+tag>`; the plaintext is the provider's own file set as JSON. */
  ciphertext: text({ notNull: true }),
  /** Advances on every write; a runner writes back against the version it leased. */
  version: integer({ notNull: true, default: 1 }),
  /** When the provider says the access token expires, if the material carries it. */
  expires_at: bigint(),
  connected_at: bigint({ notNull: true }),
  updated_at: bigint({ notNull: true }),
}, {
  primaryKey: ['user_id', 'provider'],
})

/** The refresh lock (§5, D2): at most one runner refreshes a credential at a time. */
export const credentialLocks = defineTable('credential_locks', {
  user_id: text({ notNull: true }),
  provider: text({ notNull: true }),
  host_id: text({ notNull: true }),
  expires_at: bigint({ notNull: true }),
}, {
  primaryKey: ['user_id', 'provider'],
})

/**
 * Who has been admitted to an organization on this service: the membership a
 * runner's credential lease is checked against. Written when an organization
 * member's socket is admitted; never read for authorization of a person, whose
 * grant is the authority.
 */
export const organizationMembers = defineTable('organization_members', {
  organization_id: text({ notNull: true }),
  user_id: text({ notNull: true }),
  display_name: text(),
  last_seen_at: bigint({ notNull: true }),
}, {
  primaryKey: ['organization_id', 'user_id'],
})

export const VAULT_TABLES = [credentialVault, credentialLocks, organizationMembers]
