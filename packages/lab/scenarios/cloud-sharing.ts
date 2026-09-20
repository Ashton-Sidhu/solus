import { WORKSPACE_AUDIENCE } from '@solus/contracts/uplink'
import { LabClient } from '../src/client'
import { personaForHost } from '../src/personas'
import { expectRefused, scenario, type ScenarioContext } from '../src/scenario'
import { bootWorkspaceService, createLabDatabase, type WorkspaceEngine } from '../src/workspace'

async function prove(ctx: ScenarioContext, engine: WorkspaceEngine, databaseUrl?: string): Promise<void> {
  const service = await bootWorkspaceService({ issuer: ctx.issuer, engine, databaseUrl })
  const clients: LabClient[] = []
  const client = (personaId: string, shareSecret?: string) => {
    const value = new LabClient({ persona: personaForHost(personaId, 'managed'), issuer: ctx.issuer, hostId: WORKSPACE_AUDIENCE, hostKind: 'cloud', hostUrl: service.url, shareSecret })
    clients.push(value)
    return value
  }
  try {
    const alice = client('alice')
    const carol = client('carol')
    ctx.check(`${engine}: owner admitted`, (await alice.connect()).ok)
    ctx.check(`${engine}: other organization admitted`, (await carol.connect()).ok)
    const source = await ctx.as('alice')
    const localWork = await source.rpc('createWork', 'Push with history', 'doc', 'before', '', undefined, 'claude-code', ctx.cwd)
    await source.rpc('agentSaveWork', localWork.id, { content: 'after' })
    await source.rpc('applyWorkComment', localWork.id, { kind: 'add', comment: { id: 'push-comment', selectedText: 'after', comment: 'Keep the comment' } })
    const transfer = await source.rpc('worksCloudExport', localWork.id)
    await alice.rpc('worksCloudImport', transfer)
    ctx.check(`${engine}: cloud push retains comments`, (await alice.rpc('loadWorkAnnotations', localWork.id))?.comments[0]?.comment === 'Keep the comment')
    ctx.check(`${engine}: cloud push retains previous content`, (await alice.rpc('loadWorkPrevious', localWork.id))?.content === 'before')
    await source.rpc('worksCloudRemove', localWork.id, transfer.fingerprint)
    ctx.check(`${engine}: pushed work has one cloud home`, (await alice.rpc('loadWork', localWork.id))?.content === 'after' && await source.rpc('loadWork', localWork.id) === null)
    const work = await alice.rpc('createWork', 'Shared cloud work', 'doc', '# Offline safe', '', undefined, 'claude-code', ctx.cwd)
    const task = await alice.rpc('tasksCreate', { title: 'Shared cloud task', body: 'Cloud body' })
    for (const resource of [{ kind: 'work', id: work.id }, { kind: 'task', id: task.id }] as const) {
      const link = await alice.rpc('shareSetLink', { resource, role: 'viewer' })
      const guest = client('maya', link!.secret)
      ctx.check(`${engine}: guest opens ${resource.kind} without runner`, (await guest.connect()).ok)
      const info = await guest.rpc('connectionsGetServerInfo')
      ctx.check(`${engine}: guest bound to requested resource`, info.share?.resource.id === resource.id)
      if (resource.kind === 'work') {
        ctx.check(`${engine}: guest reads work`, (await guest.rpc('loadWork', work.id))?.content === '# Offline safe')
        await expectRefused(ctx, 'viewer cannot edit work', guest.rpc('saveWork', work.id, { content: 'wrong' }))
        await expectRefused(ctx, 'other organization cannot read work', carol.rpc('loadWork', work.id))
        await alice.rpc('shareSetLink', { resource, role: 'editor' })
        await guest.rpc('saveWork', work.id, { content: 'Guest edit' })
        ctx.check(`${engine}: role upgrade applies to live guest`, (await alice.rpc('loadWork', work.id))?.content === 'Guest edit')
      } else {
        const details = await guest.rpc('tasksGet', task.id)
        ctx.check(`${engine}: guest reads task`, !!details)
        await expectRefused(ctx, 'task guest cannot read unrelated work', guest.rpc('loadWork', work.id))
      }
      await alice.rpc('shareSetLink', { resource, role: 'viewer', regenerate: true })
      const stale = client('maya', link!.secret)
      ctx.check(`${engine}: old link refused`, !(await stale.connect()).ok)
      guest.close()
    }
    const hostGuest = new LabClient({ persona: personaForHost('maya', 'personal'), issuer: ctx.issuer, hostId: ctx.host.hostId, hostKind: ctx.hostKind, hostUrl: ctx.host.tunnelUrl, shareSecret: 'a'.repeat(43) })
    clients.push(hostGuest)
    ctx.check(`${engine}: runner refuses guest admission`, !(await hostGuest.connect()).ok)
  } finally {
    for (const item of clients) item.close()
    await service.stop()
  }
}

export default scenario('cloud sharing: resources stay readable without runners; guests stay in their resource and organization', async (ctx) => {
  await prove(ctx, 'sqlite')
  if (!process.env.POSTGRES_ADMIN_URL) return
  const database = await createLabDatabase(process.env.POSTGRES_ADMIN_URL)
  try { await prove(ctx, 'postgres', database.url) } finally { await database.drop() }
}, { only: 'personal' })
