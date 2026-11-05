import { createHash } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { spawnSync } from 'node:child_process'
import model from '../resources/transcription/model.json'

// Release CI mirrors the pinned, checksum-verified model before publishing
// the app that needs it. Runtime downloads continue to use releases.solus.sh.
const key = `models/${model.name}/${model.version}/${model.file}`
const endpoint = `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`
const env = {
  ...process.env,
  AWS_ACCESS_KEY_ID: process.env.R2_ACCESS_KEY_ID,
  AWS_SECRET_ACCESS_KEY: process.env.R2_SECRET_ACCESS_KEY,
  AWS_DEFAULT_REGION: 'auto',
}
for (const name of ['R2_ACCOUNT_ID', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY'])
  if (!process.env[name]) throw new Error(`Missing ${name}`)
const existing = spawnSync('aws', ['s3api', 'head-object', '--bucket', 'solus-releases', '--key', key, '--endpoint-url', endpoint], { env, encoding: 'utf8' })
const metadata: { Metadata?: { sha256?: string } } | null = existing.status === 0 ? JSON.parse(existing.stdout) : null
if (metadata?.Metadata?.sha256 !== model.sha256) {
  const directory = await mkdtemp(join(tmpdir(), 'solus-voice-model-'))
  try {
    const response = await fetch(model.source)
    if (!response.ok || !response.body) throw new Error(`Model download failed: ${response.status}`)
    const file = join(directory, model.file)
    const hash = createHash('sha256')
    // SAFETY: Node and DOM declarations describe the same WHATWG response stream.
    const source = Readable.fromWeb(response.body as import('node:stream/web').ReadableStream<Uint8Array>)
    source.on('data', chunk => hash.update(chunk))
    await pipeline(source, createWriteStream(file))
    if (hash.digest('hex') !== model.sha256) throw new Error('Voice model checksum mismatch')
    const upload = spawnSync('aws', ['s3', 'cp', file, `s3://solus-releases/${key}`, '--metadata', `sha256=${model.sha256}`, '--endpoint-url', endpoint], { env, stdio: 'inherit' })
    if (upload.status !== 0) throw new Error('Voice model upload failed')
  } finally { await rm(directory, { recursive: true, force: true }) }
}
console.log(`Voice model ready: ${key}`)
