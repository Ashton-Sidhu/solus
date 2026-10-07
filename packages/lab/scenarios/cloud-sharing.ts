import { SOLUS_API_AUDIENCE } from '@solus/contracts/uplink'
import { LabClient } from '../src/client'
import { bootLabHost, type LabHost } from '../src/host'
import { ORGANIZATION_ID, PERSONAS, personaForHost } from '../src/personas'
import { expectRefused, scenario, type ScenarioContext } from '../src/scenario'
import { bootLabSolusApi, createLabDatabase, type SolusApiEngine } from '../src/solus-api'

async function prove(ctx: ScenarioContext, engine: SolusApiEngine, databaseUrl?: string): Promise<void> {
  const service = await bootLabSolusApi({ issuer: ctx.issuer, engine, databaseUrl })
  ctx.issuer.setWorkspaceRoute(service.url)
  let runner: LabHost | null = null
  const clients: LabClient[] = []
  const client = (personaId: string, shareSecret?: string) => {
    const value = new LabClient({ persona: personaForHost(personaId, 'managed'), issuer: ctx.issuer, hostId: SOLUS_API_AUDIENCE, hostKind: 'cloud', hostUrl: service.url, shareSecret })
    clients.push(value)
    return value
  }
  try {
    const alice = client('alice')
    const carol = client('carol')
    ctx.check(`${engine}: owner admitted`, (await alice.connect()).ok)
    ctx.check(`${engine}: other organization admitted`, (await carol.connect()).ok)
    runner = await bootLabHost({ flavor: 'personal', issuer: ctx.issuer, hostId: `labpublish${engine}`, runnerOf: ORGANIZATION_ID })
    const source = new LabClient({ persona: personaForHost('alice', 'personal'), issuer: ctx.issuer, hostId: runner.hostId, hostKind: 'personal', hostOwnerUserId: PERSONAS.alice.userId, hostUrl: runner.tunnelUrl })
    clients.push(source)
    ctx.check(`${engine}: publication source admitted`, (await source.connect()).ok)
    await source.rpc('hostOrganizations')
    const localWork = await source.records.createWork('Push with history', 'doc', 'before', '', undefined, 'claude-code', ctx.cwd)
    await source.rpc('agentSaveWork', localWork.id, { content: 'after' }, localWork.contentVersion)
    await source.rpc('applyWorkComment', localWork.id, { kind: 'add', comment: { id: 'push-comment', selectedText: 'after', comment: 'Keep the comment' } })
    // The client reads the Local work from its host, uploads it with its own sign-in, then marks it moved (cloud-sharing.md §3).
    const transfer = await source.rpc('workExportForCloud', localWork.id)
    await alice.rpc('workUpload', transfer)
    await source.rpc('workMarkMoved', localWork.id, transfer.fingerprint, ORGANIZATION_ID)
    ctx.check(`${engine}: cloud push retains comments`, (await alice.rpc('loadWorkAnnotations', localWork.id))?.comments[0]?.comment === 'Keep the comment')
    const history = await alice.rpc('loadWorkRevisions', localWork.id)
    const firstBody = history[0] ? (await alice.rpc('loadWorkRevision', localWork.id, history[0].revisionId)).content : null
    ctx.check(`${engine}: cloud push retains history`, firstBody === 'before' && history.length >= 2)
    ctx.check(`${engine}: pushed work has one cloud home`, (await alice.records.loadWork(localWork.id))?.content === 'after' && await source.records.loadWork(localWork.id) === null)
    const work = await alice.records.createWork('Shared cloud work', 'doc', '# Offline safe', '', undefined, 'claude-code', ctx.cwd)
    const task = await alice.records.tasksCreate({ title: 'Shared cloud task', body: 'Cloud body' })
    // A task is not shared: its organization sees it, and it has no guest link.
    await expectRefused(ctx, 'a task has no share link', alice.rpc('shareSetLink', { resource: { kind: 'task', id: task.id }, role: 'viewer' }), 'FORBIDDEN')
    for (const resource of [{ kind: 'work', id: work.id }] as const) {
      const link = await alice.rpc('shareSetLink', { resource, role: 'viewer' })
      const guest = client('maya', link!.secret)
      ctx.check(`${engine}: guest opens ${resource.kind} without runner`, (await guest.connect()).ok)
      const info = await guest.rpc('connectionsGetServerInfo')
      ctx.check(`${engine}: guest bound to requested resource`, info.share?.resource.id === resource.id)
      if (resource.kind === 'work') {
        ctx.check(`${engine}: guest reads work`, (await guest.records.loadWork(work.id))?.content === '# Offline safe')
        await expectRefused(ctx, 'viewer cannot edit work', guest.records.saveWork(work.id, { content: 'wrong' }, work), 'NOT_FOUND')
        await expectRefused(ctx, 'other organization cannot read work', carol.api.request('getWork', { id: work.id }), 'NOT_FOUND')
        await alice.rpc('shareSetLink', { resource, role: 'editor' })
        const viewedVersion = (await alice.records.loadWork(work.id))?.updatedAt
        await guest.records.saveWork(work.id, { content: 'Guest edit' }, work)
        const savedVersion = (await alice.records.loadWork(work.id))?.updatedAt
        ctx.check(`${engine}: reader detects another editor's save`, savedVersion !== viewedVersion)
        let refused = false
        try { await alice.records.saveWork(work.id, { content: 'Stale draft' }, work) }
        catch { refused = true }
        ctx.check(`${engine}: stale copy cannot overwrite the saved change`, refused)
        await expectRefused(ctx, 'other organization cannot check work version', carol.api.request('getWork', { id: work.id, ifNoneMatch: work.updatedAt }), 'NOT_FOUND')
        ctx.check(`${engine}: role upgrade applies to live guest`, (await alice.records.loadWork(work.id))?.content === 'Guest edit')
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
    if (runner) await runner.stop()
    ctx.issuer.setWorkspaceRoute(null)
    await service.stop()
  }
}

export default scenario('cloud sharing: resources stay readable without runners; guests stay in their resource and organization', async (ctx) => {
  await prove(ctx, 'sqlite')
  if (!process.env.POSTGRES_ADMIN_URL) return
  const database = await createLabDatabase(process.env.POSTGRES_ADMIN_URL)
  try { await prove(ctx, 'postgres', database.url) } finally { await database.drop() }
}, { only: 'personal' })
