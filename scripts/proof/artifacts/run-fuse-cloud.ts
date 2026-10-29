import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { ArtifactsCloud } from './cloud'
import { command } from './process'

// Credentials travel over SSH stdin and process environment, never command arguments or files.
const outdir = resolve(process.argv[2] ?? '.solus-local/artifacts-proof/results/fuse-cloud')
await mkdir(outdir, { recursive: true })
const cloud = await ArtifactsCloud.fromWrangler(process.env.CLOUDFLARE_ACCOUNT_ID ?? '', `solus-proof-${Date.now().toString(36)}`)
let failed = false
try {
  const remote = await cloud.create('fuse')
  const result = await command('ssh', ['-o', 'BatchMode=yes', '10.10.1.79', 'node /tmp/solus-proof-fuse-2b87a48.mjs /tmp/solus-proof-artifact-fs-2b87a48 /tmp/solus-proof-fuse-cloud-results-2b87a48 --remote-stdin'], { input: JSON.stringify(remote), allowFailure: true })
  console.log(result.stdout)
  await writeFile(`${outdir}/execution.json`, JSON.stringify(result, null, 2))
  if (result.code !== 0) { failed = true; console.error(result.stderr) }
  await command('scp', ['10.10.1.79:/tmp/solus-proof-fuse-cloud-results-2b87a48/fuse.json', `${outdir}/fuse.json`])
} finally {
  const cleanupErrors = await cloud.cleanup()
  await writeFile(`${outdir}/cleanup.json`, JSON.stringify({ operations: cloud.operations, cleanupErrors }, null, 2))
  if (cleanupErrors.length) failed = true
}
if (failed) throw new Error('Cloud FUSE proof failed; read its result JSON')
