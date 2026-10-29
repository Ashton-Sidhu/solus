import { Database } from 'bun:sqlite'
import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { z } from 'zod'
import { SOLUS_API_AUDIENCE } from '@solus/contracts/uplink'
import { WorkspaceRequestError } from '@solus/contracts/solus-api/client'
import { LabClient } from '../src/client'
import { bootLabHost, type LabHost } from '../src/host'
import { bootLabSolusApi } from '../src/solus-api'
import { ORGANIZATION_ID, personaForHost } from '../src/personas'
import { expectRefused, scenario } from '../src/scenario'

const mappingSchema = z.object({ provider: z.string(), repository: z.string(), commit_id: z.string().nullable(), generation: z.number(), archived_generation: z.number() })
async function until<T>(read: () => Promise<T>, accept: (value: T) => boolean): Promise<T> {
  const deadline = Date.now() + 90_000
  do {
    const value = await read()
    if (accept(value)) return value
    await new Promise(resolve => setTimeout(resolve, 100))
  } while (Date.now() < deadline)
  throw new Error('The work archive did not reach its expected state.')
}

function artifactsConfiguration() {
  const cloudflare = process.env.SOLUS_LAB_ARTIFACTS === '1'
  const account = process.env.SOLUS_LAB_ARTIFACTS_ACCOUNT_ID
  const namespace = process.env.SOLUS_LAB_ARTIFACTS_NAMESPACE ?? 'default'
  const token = process.env.SOLUS_LAB_ARTIFACTS_TOKEN
  if (cloudflare && (!account || !token)) throw new Error('The real Artifacts Lab needs an account and a server token.')
  return { cloudflare, account, namespace, token, provider: cloudflare ? 'cloudflare-artifacts' : 'local-git' }
}

function collectLogs(label: string, directory: string | undefined, evidence: string): void {
  if (!directory) return
  if (existsSync(join(directory, 'lab'))) cpSync(join(directory, 'lab'), join(evidence, label), { recursive: true })
  rmSync(directory, { recursive: true, force: true })
}

/** Lab-issuer mode exercises the same storage flow with a local or real Cloudflare destination. */
export default scenario('work Git storage: local restart, publication, shared editing and revoked access', async ctx => {
  const { cloudflare, account, namespace, token, provider } = artifactsConfiguration()
  const evidence = resolve('.solus-local/lab-cloud/evidence', `work-git-${Date.now()}`)
  mkdirSync(evidence, { recursive: true })
  let host: LabHost | undefined
  const service = await bootLabSolusApi({ issuer: ctx.issuer, engine: 'sqlite', environment: {
    SOLUS_WORK_STORAGE: provider,
    SOLUS_ARTIFACTS_ACCOUNT_ID: account, SOLUS_ARTIFACTS_NAMESPACE: namespace, SOLUS_ARTIFACTS_API_TOKEN: token,
  } })
  const clients: LabClient[] = []
  const databases: Database[] = []
  const remoteRepositories = new Set<string>()
  const cloudRequest = (repository: string, method = 'GET') => fetch(`https://api.cloudflare.com/client/v4/accounts/${account}/artifacts/namespaces/${namespace}/repos/${repository}`, {
    method, headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(30_000),
  })
  function openDatabase(directory: string): Database { const db = new Database(join(directory, 'solus.db'), { readonly: true }); databases.push(db); return db }
  async function archived(db: Database, workId: string, provider: string) {
    const row = await until(async () => mappingSchema.nullish().parse(db.query('SELECT * FROM work_storage WHERE work_id = ?').get(workId)), value => !!value?.commit_id && value.generation === value.archived_generation)
    ctx.check(`${workId}: ${provider} accepted the archive`, row?.provider === provider)
    return row!
  }
  const cloudClient = (id: string, shareSecret?: string) => {
    const client = new LabClient({ persona: personaForHost(id, 'managed'), issuer: ctx.issuer, hostId: SOLUS_API_AUDIENCE, hostKind: 'cloud', hostUrl: service.url, shareSecret })
    clients.push(client); return client
  }
  const localClient = () => {
    const current = host!
    const client = new LabClient({ persona: personaForHost('alice', 'personal'), issuer: ctx.issuer, hostId: current.hostId, hostKind: 'personal', hostUrl: current.localUrl, credentialFree: true, localOwnerToken: () => current.localOwnerToken() })
    clients.push(client); return client
  }
  try {
    host = await bootLabHost({ flavor: 'personal', issuer: ctx.issuer })
    let source = localClient()
    ctx.check('local owner admitted', (await source.connect()).ok)
    let localDb = openDatabase(host.dataDir)
    for (const type of ['doc', 'diagram', 'slides', 'artifact'] as const) {
      const before = type === 'diagram' ? '{"nodes":[],"edges":[]}' : 'Original local content\n\n'
      const after = type === 'diagram' ? '{"nodes":[{"id":"a","label":"Local edit"}],"edges":[]}' : 'Changed local content\n\n'
      const work = await source.records.createWork(`Local Git ${type}`, type, before, '', undefined, 'codex')
      await archived(localDb, work.id, 'local-git')
      await source.rpc('agentSaveWork', work.id, { content: after }, work.contentVersion)
      const mapping = await archived(localDb, work.id, 'local-git')
      const repository = join(host.dataDir, 'works/history', `${mapping.repository}.git`)
      const commits = execFileSync('git', ['--git-dir', repository, 'rev-list', '--count', 'main'], { encoding: 'utf8' }).trim()
      ctx.check(`${type}: a native Git repository has two commits`, commits === '2')
      ctx.check(`${type}: archived history reads the original`, (await source.rpc('loadWorkRevision', work.id, 1)).content === before)
      await source.rpc('restoreWorkRevision', work.id, 1, 2)
      await archived(localDb, work.id, 'local-git')
      ctx.check(`${type}: restore reaches the current work`, (await source.records.loadWork(work.id))?.content === before)
      await source.records.deleteWork(work.id)
      await until(async () => existsSync(repository), value => !value)
      ctx.check(`${type}: delete removes its Git repository`, true)
    }
    const local = await source.records.createWork('Publish local Git history', 'doc', 'Before publication', '', undefined, 'codex')
    await source.rpc('agentSaveWork', local.id, { content: 'Ready to publish' }, local.contentVersion)
    await archived(localDb, local.id, 'local-git')
    source.close(); localDb.close()
    await host.stop()
    host = await bootLabHost({ flavor: 'personal', issuer: ctx.issuer, dataDir: host.dataDir })
    source = localClient(); ctx.check('local owner reconnects after restart', (await source.connect()).ok)
    localDb = openDatabase(host.dataDir)
    ctx.check('restart retains the current work', (await source.records.loadWork(local.id))?.content === 'Ready to publish')
    ctx.check('restart reads original history from Git', (await source.rpc('loadWorkRevision', local.id, 1)).content === 'Before publication')
    const alice = cloudClient('alice'), bob = cloudClient('bob'), carol = cloudClient('carol')
    for (const client of [alice, bob, carol]) ctx.check(`${client.persona.id} admitted to the service`, (await client.connect()).ok)
    const transfer = await source.rpc('workExportForCloud', local.id)
    const cloudDb = openDatabase(service.dataDir)
    try { await alice.rpc('workUpload', transfer) } finally {
      const mapping = mappingSchema.nullish().parse(cloudDb.query('SELECT * FROM work_storage WHERE work_id = ?').get(local.id))
      if (mapping && cloudflare) remoteRepositories.add(mapping.repository)
    }
    await archived(cloudDb, local.id, provider)
    await source.rpc('workMarkMoved', local.id, transfer.fingerprint, ORGANIZATION_ID)
    const moved = await source.records.loadWork(local.id).then(() => false, error => error instanceof WorkspaceRequestError && error.code === 'MOVED')
    ctx.check('publication moves the local work only after archive acceptance', moved)
    ctx.check('Bob reads the published content', (await bob.records.loadWork(local.id))?.content === 'Ready to publish')
    ctx.check('Bob reads the published original revision', (await bob.rpc('loadWorkRevision', local.id, 1)).content === 'Before publication')
    await expectRefused(ctx, 'another organization cannot read the work', carol.api.request('getWork', { id: local.id }), 'NOT_FOUND')
    const resource = { kind: 'work', id: local.id } as const
    const link = await alice.rpc('shareSetLink', { resource, role: 'viewer' })
    const guest = cloudClient('maya', link!.secret)
    ctx.check('guest opens the published work', (await guest.connect()).ok)
    const viewed = (await guest.records.loadWork(local.id))!
    ctx.check('guest reads published content', viewed.content === 'Ready to publish')
    await expectRefused(ctx, 'viewer cannot save', guest.records.saveWork(local.id, { content: 'Forbidden' }, viewed), 'NOT_FOUND')
    await alice.rpc('shareSetLink', { resource, role: 'editor' })
    await guest.records.saveWork(local.id, { content: 'Guest edit on Git history' }, viewed)
    await archived(cloudDb, local.id, provider)
    ctx.check('Bob sees the guest edit', (await bob.records.loadWork(local.id))?.content === 'Guest edit on Git history')
    await expectRefused(ctx, 'stale draft cannot replace the guest edit', alice.records.saveWork(local.id, { content: 'Stale' }, viewed), 'STALE_VERSION')
    await alice.rpc('shareSetLink', { resource, role: 'viewer', regenerate: true })
    const revoked = cloudClient('maya', link!.secret)
    ctx.check('the old share link cannot reconnect', !(await revoked.connect()).ok)
    await alice.records.loadWork(local.id)
    await alice.records.deleteWork(local.id)
    await until(async () => cloudDb.query('SELECT work_id FROM work_storage WHERE work_id = ?').get(local.id), row => row === null)
    ctx.check('deletion completes archive cleanup', true)
  } finally {
    for (const client of clients) client.close()
    for (const db of databases) db.close()
    if (host) await host.stop()
    await service.stop()
    for (const [label, directory] of [['service', service.dataDir], ['host', host?.dataDir]] as const) {
      collectLogs(label, directory, evidence)
    }
    for (const repository of remoteRepositories) {
      const removed = await cloudRequest(repository, 'DELETE')
      ctx.check('Cloudflare test repository removed', (removed.ok || removed.status === 404) && (await cloudRequest(repository)).status === 404)
    }
    ctx.step(`Evidence: ${evidence}`)
  }
}, { only: 'personal' })
