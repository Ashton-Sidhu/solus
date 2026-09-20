import { WORKSPACE_AUDIENCE } from '@solus/contracts/uplink'
import { LabClient } from './client'
import { personaForHost } from './personas'
import { scenario, type ScenarioContext, type ScenarioDefinition } from './scenario'
import { bootWorkspaceService, createLabDatabase, type WorkspaceEngine } from './workspace'

/** Resource permissions belong to the workspace service. Run their matrix on
 * each database engine without letting the fixture admit a human host owner. */
export function cloudScenario(name: string, run: (ctx: ScenarioContext) => Promise<void>): ScenarioDefinition {
  return scenario(name, async (parent) => {
    async function prove(engine: WorkspaceEngine, databaseUrl?: string): Promise<void> {
      const service = await bootWorkspaceService({ issuer: parent.issuer, engine, databaseUrl })
      const clients: LabClient[] = []
      const connected = new Map<string, LabClient>()
      const client: ScenarioContext['client'] = (personaId, options = {}) => {
        const value = new LabClient({ persona: personaForHost(personaId, 'managed'), issuer: parent.issuer, hostId: WORKSPACE_AUDIENCE, hostKind: 'cloud', hostUrl: service.url, shareSecret: options.shareSecret })
        clients.push(value)
        return value
      }
      const ctx: ScenarioContext = {
        ...parent, hostKind: 'cloud',
        host: { ...parent.host, hostId: WORKSPACE_AUDIENCE, tunnelUrl: service.url, localUrl: service.url },
        check: (label, ok, detail) => parent.check(`${engine}: ${label}`, ok, detail),
        client,
        async as(personaId) {
          const current = connected.get(personaId)
          if (current?.connected) return current
          const value = client(personaId)
          if (!(await value.connect()).ok) throw new Error(`${personaId} could not connect to the workspace`)
          connected.set(personaId, value)
          return value
        },
      }
      try { await run(ctx) } finally { for (const value of clients) value.close(); await service.stop() }
    }
    await prove('sqlite')
    if (!process.env.POSTGRES_ADMIN_URL) return
    const database = await createLabDatabase(process.env.POSTGRES_ADMIN_URL)
    try { await prove('postgres', database.url) } finally { await database.drop() }
  }, { only: 'personal' })
}
