// Uploads release artifacts to the Cloudflare R2 releases bucket.
//
// This deliberately uses Bun's built-in S3 client rather than the AWS CLI. The
// CLI on macOS runners bundles its own Python OpenSSL, whose ClientHello the
// Cloudflare edge rejects with SSLV3_ALERT_HANDSHAKE_FAILURE before any bytes
// move. Bun talks to R2 over its own TLS stack and handles multipart uploads
// for the large disk images itself.

import { readdirSync, statSync } from 'fs'
import { join, resolve } from 'path'

const BUCKET = 'solus-releases'
const UPLOAD_EXTENSIONS = ['.dmg', '.zip', '.yml', '.blockmap']
// electron-updater and the download page both point at this stable key.
const STABLE_DMG_KEY = 'Solus-latest-arm64.dmg'

const repoRoot = resolve(import.meta.dir, '..')

async function main(): Promise<void> {
  const accountId = requireEnv('R2_ACCOUNT_ID')
  const client = new Bun.S3Client({
    accessKeyId: requireEnv('R2_ACCESS_KEY_ID'),
    secretAccessKey: requireEnv('R2_SECRET_ACCESS_KEY'),
    bucket: BUCKET,
    region: 'auto',
    endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
  })

  const releaseDir = join(repoRoot, 'release')
  const names = readdirSync(releaseDir).filter(
    (name) =>
      UPLOAD_EXTENSIONS.some((extension) => name.endsWith(extension)) &&
      statSync(join(releaseDir, name)).isFile(),
  )
  if (names.length === 0) throw new Error(`No release artifacts found in ${releaseDir}`)

  for (const name of names) {
    await upload(client, join(releaseDir, name), name)
  }

  const stableSource = names.find((name) => name.endsWith('-arm64.dmg'))
  if (stableSource) {
    await upload(client, join(releaseDir, stableSource), STABLE_DMG_KEY)
  }
}

async function upload(client: Bun.S3Client, path: string, key: string): Promise<void> {
  const file = Bun.file(path)
  const megabytes = (file.size / 1_000_000).toFixed(1)
  console.log(`Uploading ${key} (${megabytes} MB)...`)
  await client.write(key, file)
}

function requireEnv(name: string): string {
  const value = process.env[name]
  if (!value) throw new Error(`Missing required environment variable: ${name}`)
  return value
}

await main()
