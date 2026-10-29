import { readFileSync, mkdirSync, writeFileSync, cpSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { Database } from 'bun:sqlite'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { z } from 'zod'
import * as Y from 'yjs'
import { LabIssuer } from '../../../packages/lab/src/issuer'
import { bootLabSolusApi } from '../../../packages/lab/src/solus-api'
import { bootLabHost } from '../../../packages/lab/src/host'
import { LabClient } from '../../../packages/lab/src/client'
import { personaForHost, ORGANIZATION_ID } from '../../../packages/lab/src/personas'
import { SOLUS_API_AUDIENCE } from '../../../packages/contracts/src/uplink'
import { createHash } from 'node:crypto'
const artifactsRepositoryName = (organizationId: string, workId: string) => `work-${createHash('sha256').update(JSON.stringify([organizationId,workId])).digest('hex').slice(0,48)}`
import { bytesToBase64, base64ToBytes } from '../../../packages/contracts/src/work-live'
import { writeDiagramToY } from '../../../packages/contracts/src/diagram-live'
const evidence = join(process.cwd(), '.solus-local/lab-cloud/evidence/artifacts')
mkdirSync(evidence, { recursive: true })
const authHome = process.env.SOLUS_LAB_AUTH_HOME ?? homedir()
execFileSync('cf', ['auth', 'whoami'], { stdio: ['ignore', 'pipe', 'pipe'], env: {...process.env, HOME: authHome} })
const auth = z.object({oauth_token:z.string().min(1)}).parse(JSON.parse(readFileSync(join(authHome,'Library/Preferences/cloudflare/config/default.json'), 'utf8')))
const account = '35eee5b216c4832e3ac2803a8ecd468f'
const base = `https://api.cloudflare.com/client/v4/accounts/${account}/artifacts/namespaces/default/repos/`
const request = (repo: string, path = '', method = 'GET') => fetch(base + repo + path, { method, headers: { authorization: `Bearer ${auth.oauth_token}` }, signal: AbortSignal.timeout(30000) })
const checks: { name: string; ok: boolean }[] = []
function check(name: string, ok: boolean) { checks.push({ name, ok }); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}`); if (!ok) throw new Error(name) }
async function until<T>(read: () => Promise<T>, accept: (value: T) => boolean, timeout = 90000): Promise<T> { const deadline = Date.now() + timeout; do { const value = await read(); if (accept(value)) return value; await new Promise(r => setTimeout(r, 250)) } while(Date.now() < deadline); throw new Error('Archive condition timed out') }
const issuer = new LabIssuer(); await issuer.start()
const keys = ['SOLUS_WORK_STORAGE', 'SOLUS_ARTIFACTS_ACCOUNT_ID', 'SOLUS_ARTIFACTS_NAMESPACE', 'SOLUS_ARTIFACTS_API_TOKEN'] as const
const old = keys.map(key => process.env[key])
process.env.SOLUS_WORK_STORAGE = 'cloudflare-artifacts'; process.env.SOLUS_ARTIFACTS_ACCOUNT_ID = account; process.env.SOLUS_ARTIFACTS_NAMESPACE = 'default'; process.env.SOLUS_ARTIFACTS_API_TOKEN = auth.oauth_token
let service: Awaited<ReturnType<typeof bootLabSolusApi>> | undefined
let host: Awaited<ReturnType<typeof bootLabHost>> | undefined
const clients: LabClient[] = []; const owned: string[] = []
let error: string | null = null
try {
 service = await bootLabSolusApi({ issuer, engine: 'sqlite' })
 keys.forEach((key,index) => old[index] === undefined ? delete process.env[key] : process.env[key] = old[index])
 const cloudClient = (id: string) => { const c = new LabClient({ persona: personaForHost(id, 'managed'), issuer, hostId: SOLUS_API_AUDIENCE, hostKind: 'cloud', hostUrl: service!.url }); clients.push(c); return c }
 const alice = cloudClient('alice'), bob = cloudClient('bob'), carol = cloudClient('carol')
 for (const c of [alice,bob,carol]) check(`${c.persona.id} admitted`, (await c.connect()).ok)
 const db = new Database(join(service.dataDir, 'solus.db'), { readonly: true })
 const archived = async (id: string, generation?: number) => until(async () => z.object({commit_id:z.string().nullable(),generation:z.number(),archived_generation:z.number()}).nullable().parse(db.query('SELECT commit_id, generation, archived_generation FROM work_storage WHERE work_id = ?').get(id)), row => !!row?.commit_id && row.generation === row.archived_generation && (generation === undefined || row.generation >= generation))
 const workTypes: ('doc'|'diagram'|'slides'|'artifact')[] = process.env.PUBLICATION_ONLY === '1' ? [] : ['doc','diagram','slides','artifact']
 for (const type of workTypes) {
  const before = type === 'diagram' ? '{"nodes":[],"edges":[]}' : type === 'artifact' ? '<html><body>Original</body></html>' : '# Original\n\n'
  const after = type === 'diagram' ? '{"nodes":[{"id":"a","label":"Edited"}],"edges":[]}' : type === 'artifact' ? '<html><body>Changed</body></html>' : '# Changed\n\n'
  const work = await alice.records.createWork(`Lab ${type}`,type,before,'',undefined,'codex')
  owned.push(work.id); const repo = artifactsRepositoryName(ORGANIZATION_ID,work.id)
  const first = await archived(work.id)
  check(`${type}: Cloudflare has initial manifest`, (await request(repo, `/file?${new URLSearchParams({ref:first!.commit_id!,path:'manifest.json'})}`)).ok)
  await alice.rpc('agentSaveWork',work.id,{content:after},work.contentVersion)
  await archived(work.id,first!.generation+1)
  check(`${type}: bob sees agent edit`, (await bob.records.loadWork(work.id))?.content === after)
  const history = await bob.rpc('loadWorkRevisions',work.id)
  const initial = history.find(r=>r.contentVersion===1) ?? history[0]!
  check(`${type}: bob reads archived original`, (await bob.rpc('loadWorkRevision',work.id,initial.revisionId)).content === before)
  const current = (await alice.records.loadWork(work.id))!
  await alice.rpc('restoreWorkRevision',work.id,initial.revisionId,current.contentVersion)
  check(`${type}: bob sees restored content`, (await bob.records.loadWork(work.id))?.content === before)
  await archived(work.id)
  if (type === 'diagram') {
   const docs = [new Y.Doc(),new Y.Doc()]
   const opened = await Promise.all([alice,bob].map((c,i)=>c.rpc('workLiveOpen',{workId:work.id,clientKey:`lab-client-${i}`,schemaVersion:1,stateVector:bytesToBase64(Y.encodeStateVector(docs[i]!))})))
   for(let i=0;i<2;i++) { const o=opened[i]!; check(`diagram: client ${i} live edit allowed`,o.mode==='edit'); if(o.mode!=='unsupported') Y.applyUpdate(docs[i]!,base64ToBytes(o.update)) }
   const vector=Y.encodeStateVector(docs[0]!); writeDiagramToY(docs[0]!,{nodes:[{id:'live',label:'Alice live edit'}],edges:[]})
   const event=bob.waitForEvent('workLive.update',e=>e.payload.workId===work.id)
   const receipt=await alice.rpc('workLivePush',{workId:work.id,clientKey:'lab-client-0',seq:1,update:bytesToBase64(Y.encodeStateAsUpdate(docs[0]!,vector))})
   check('diagram: live push acknowledged',receipt.status==='accepted')
   check('diagram: bob receives live update',(await event).payload.workId===work.id)
   await until(()=>bob.records.loadWork(work.id),w=>!!w?.content?.includes('Alice live edit'))
   check('diagram: bob reads live body',true)
   const final=await archived(work.id)
   const content=await (await request(repo,`/file?${new URLSearchParams({ref:final!.commit_id!,path:'content.json'})}`)).text()
   check('diagram: Cloudflare archives live edit',content.includes('Alice live edit'))
  }
  check(`${type}: another organization cannot read`,(await carol.records.loadWork(work.id))===null)
 }
 // Publication goes from a separate offline-capable host to the Artifacts-backed service.
 host=await bootLabHost({flavor:'personal',issuer})
 const source=new LabClient({persona:personaForHost('alice','personal'),issuer,hostId:host.hostId,hostKind:'personal',hostUrl:host.localUrl,credentialFree:true,localOwnerToken:async()=>z.object({sessionToken:z.string().min(1)}).parse(JSON.parse(execFileSync('node',[process.env.SOLUS_LAB_ENTRY!,'auth','session','create','--data-dir',host!.dataDir,'--json'],{encoding:'utf8',env:{...process.env,SOLUS_DATA_DIR:host!.dataDir}}))).sessionToken}); clients.push(source)
 check('local publication source admitted',(await source.connect()).ok)
 const local=await source.records.createWork('Offline publication','artifact','<html>Before publication</html>','',undefined,'codex')
 await source.rpc('agentSaveWork',local.id,{content:'<html>Published</html>'},local.contentVersion)
 const transfer=await source.rpc('workExportForCloud',local.id)
 owned.push(local.id)
 await alice.rpc('workUpload',transfer)
 check('publication: archive accepted before upload returns',!!(await archived(local.id))?.commit_id)
 await source.rpc('workMarkMoved',local.id,transfer.fingerprint,ORGANIZATION_ID)
 check('publication: bob sees content',(await bob.records.loadWork(local.id))?.content==='<html>Published</html>')
 let moved=false;try{await source.records.loadWork(local.id)}catch(e){moved=e instanceof Error && e.message.includes('moved to organization')}
 check('publication: local source marked moved',moved)
 db.close()
} catch(e) { error=e instanceof Error?e.message:'Unexpected failure'; console.log('FAIL',error) }
finally {
 keys.forEach((key,index) => old[index] === undefined ? delete process.env[key] : process.env[key] = old[index])
 for(const c of clients)c.close()
 if(host)await host.stop()
 if(service) { await service.stop(); cpSync(join(service.dataDir,'lab'),join(evidence,'service'),{recursive:true}) }
 await issuer.stop()
 for(const id of owned) { const repo=artifactsRepositoryName(ORGANIZATION_ID,id); const removed=await request(repo,'','DELETE'); const confirmed=await request(repo); checks.push({name:`cleanup ${id}`,ok:(removed.ok||removed.status===404)&&confirmed.status===404}) }
 writeFileSync(join(evidence,'summary.json'),JSON.stringify({checks,error,temporaryDirectories:[service?.dataDir,host?.dataDir].filter(Boolean)},null,2))
}
process.exit(error || checks.some(c=>!c.ok)?1:0)
