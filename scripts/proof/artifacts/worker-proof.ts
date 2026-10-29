import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { z } from 'zod'
import { ArtifactsCloud } from './cloud'
import { command, git, ProofReport } from './process'

const outdir = resolve(process.argv[2] ?? '.solus-local/artifacts-proof/results/worker')
await mkdir(outdir, { recursive: true })
const root = await mkdtemp(join(tmpdir(), 'solus-proof-worker-'))
const name = `solus-proof-${Date.now().toString(36)}`
const cloud = await ArtifactsCloud.fromWrangler(process.env.CLOUDFLARE_ACCOUNT_ID ?? '', name)
const wrangler = process.env.ARTIFACTS_PROOF_WRANGLER ?? '/Users/sidhu/solus-cloud/host-worker/node_modules/wrangler/bin/wrangler.js'
const report = new ProofReport()
const config = join(root, 'wrangler.json')
let deployed = false
let cleanupErrors: string[] = []
try {
  const remote = await cloud.create('binding')
  await git(root, ['init', '--initial-branch=main'])
  for (const text of ['first', 'second']) {
    await writeFile(join(root, 'proof.txt'), text)
    await git(root, ['add', 'proof.txt'])
    await git(root, ['commit', '-m', text])
  }
  await git(root, ['push', remote.url, 'main'], { remote })
  const head = (await git(root, ['rev-parse', 'HEAD'])).stdout.trim()
  const previous = (await git(root, ['rev-parse', 'HEAD^'])).stdout.trim()
  await writeFile(config, JSON.stringify({ name, account_id: cloud.accountId, main: resolve(import.meta.dir, 'binding-worker.ts'), compatibility_date: '2026-10-01', workers_dev: true, artifacts: [{ binding: 'ARTIFACTS', namespace: cloud.namespace }], vars: { PROOF_REPO: remote.name } }))
  const env = { CI: 'true', WRANGLER_SEND_METRICS: 'false' }
  const generated = await command('node', [wrangler, 'types', join(outdir, 'worker-configuration.d.ts'), '--config', config], { env })
  await writeFile(join(outdir, 'types-output.txt'), generated.stdout)
  // Mark before deployment so an upload with a lost response still receives cleanup.
  deployed = true
  const upload = await command('node', [wrangler, 'deploy', '--config', config], { env })
  const origin = upload.stdout.match(/https:\/\/[a-z0-9.-]+\.workers\.dev/)?.[0]
  if (!origin) throw new Error('Wrangler did not return this proof Worker URL')
  const token = randomBytes(32).toString('hex')
  await command('node', [wrangler, 'secret', 'put', 'PROOF_TOKEN', '--config', config], { env, input: token })
  const get = async (path: string, method = 'GET') => fetch(`${origin}${path}`, { method, headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(30_000) })
  const deadline = Date.now() + 90_000
  for (;;) {
    const ready = await get('/ready')
    if (ready.status === 200 && await ready.text() === 'ready') break
    if (Date.now() >= deadline) throw new Error('Worker secret deployment did not become ready')
    await new Promise(resolve => setTimeout(resolve, 500))
  }
  await report.check('Worker binding reads current and historical file content without a repository checkout', async () => {
    assert.equal(await (await get(`/file?ref=${head}`)).text(), 'second')
    assert.equal(await (await get(`/file?ref=${previous}`)).text(), 'first')
  })
  await report.check('Worker binding returns immutable commit history', async () => {
    const response = await get('/history')
    assert.equal(response.status, 200)
    const entries = z.array(z.object({ hash: z.string() }).passthrough()).parse(await response.json())
    assert.equal(entries.length, 2)
    assert.equal(entries[0]!.hash, head)
  })
  await report.check('Worker binding forks a repository and removes the disposable fork', async () => {
    cloud.registerFork(remote.name)
    const response = await get('/fork', 'POST')
    assert.equal(response.status, 200)
    assert.equal(z.object({ name: z.string() }).parse(await response.json()).name, `${remote.name}-fork`)
    assert.equal((await get('/delete-fork', 'POST')).status, 200)
  })
  await report.check('Worker binding revokes a token and Git refuses it', async () => {
    const response = await get('/revocation', 'POST')
    const revoked = z.object({ revoked: z.literal(true), token: z.string() }).parse(await response.json())
    assert.notEqual((await git(root, ['ls-remote', remote.url], { remote: { url: remote.url, token: revoked.token }, allowFailure: true })).code, 0)
  })
  await report.check('the test Worker refuses unauthenticated content access', async () => {
    assert.equal((await fetch(`${origin}/file`)).status, 401)
  })
} finally {
  if (deployed) {
    const deleted = await command('node', [wrangler, 'delete', '--config', config, '--force'], { env: { CI: 'true', WRANGLER_SEND_METRICS: 'false' }, allowFailure: true })
    if (deleted.code !== 0) cleanupErrors.push('Could not delete the test Worker')
  }
  cleanupErrors.push(...await cloud.cleanup())
  await writeFile(join(outdir, 'worker.json'), JSON.stringify({ checks: report.checks, cleanupErrors, controlPlaneRequests: cloud.operations }, null, 2))
  await rm(root, { recursive: true, force: true })
}
if (report.checks.some(check => check.status === 'fail') || cleanupErrors.length) throw new Error('Worker proof failed; read worker.json')
