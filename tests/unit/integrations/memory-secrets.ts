import type { OAuthClient } from '@solus/contracts/integrations/oauth-protocol'
import type { IntegrationClients } from '@solus/server/integrations/connection-store'
import type { SecretStore } from '@solus/server/platform/secrets'

/** A host secret store in memory, for a vault under test. `values` holds each saved key as JSON. */
export function memorySecretStore(): SecretStore & { values: Map<string, string> } {
  const values = new Map<string, string>()
  return {
    values,
    canSave: () => true,
    loadJson: (key, _path, schema) => {
      const value = values.get(key)
      return value ? schema.parse(JSON.parse(value)) : null
    },
    saveJson: (key, _path, value) => { values.set(key, JSON.stringify(value)) },
    remove: (key) => { values.delete(key) },
  }
}

/** The host's registered OAuth clients in memory. */
export function memoryClients(): IntegrationClients & { clients: Map<string, OAuthClient> } {
  const clients = new Map<string, OAuthClient>()
  return {
    clients,
    client: (id, issuer) => clients.get(`${id}\u0000${issuer}`) ?? null,
    saveClient: (id, issuer, client) => { clients.set(`${id}\u0000${issuer}`, client) },
    removeClient: (id) => { for (const key of clients.keys()) if (key.startsWith(`${id}\u0000`)) clients.delete(key) },
  }
}
