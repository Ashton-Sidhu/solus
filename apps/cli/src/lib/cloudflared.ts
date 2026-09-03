import { spawn } from 'child_process'
import { createHash } from 'crypto'
import {
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'fs'
import { basename, dirname, join } from 'path'

export const CLOUDFLARED_VERSION = '2026.5.2'

export interface ReleaseAsset {
  url: string
  sha256: string
  archive: 'binary' | 'tgz'
}

const RELEASE_ASSETS = {
  'darwin-arm64': {
    url: `https://github.com/cloudflare/cloudflared/releases/download/${CLOUDFLARED_VERSION}/cloudflared-darwin-arm64.tgz`,
    sha256: 'ba94054c9fd4297645093d59d51442e5e546d07bb0516120e694a13d5b216d38',
    archive: 'tgz',
  },
  'darwin-x64': {
    url: `https://github.com/cloudflare/cloudflared/releases/download/${CLOUDFLARED_VERSION}/cloudflared-darwin-amd64.tgz`,
    sha256: '7240f709506bc2c1eb9da4d89cf2555499c60280ecb854b7d80e8f17d4b7903d',
    archive: 'tgz',
  },
  'linux-arm64': {
    url: `https://github.com/cloudflare/cloudflared/releases/download/${CLOUDFLARED_VERSION}/cloudflared-linux-arm64`,
    sha256: '5a4e8ce2701105271412059f44b6a0bf1ae4542b4d98ff3180c0c019443a5815',
    archive: 'binary',
  },
  'linux-x64': {
    url: `https://github.com/cloudflare/cloudflared/releases/download/${CLOUDFLARED_VERSION}/cloudflared-linux-amd64`,
    sha256: '5286698547f03df745adb2355f04c12dde52ef425491e81f433642d695521886',
    archive: 'binary',
  },
} satisfies Partial<Record<string, ReleaseAsset>>

export interface CloudflaredInstallOptions {
  dataDir: string
  fetchImpl?: typeof fetch
  platform?: NodeJS.Platform
  arch?: string
  asset?: ReleaseAsset
  validateBinary?: (path: string) => Promise<void>
}

export function managedCloudflaredPath(dataDir: string, platform: NodeJS.Platform = process.platform): string {
  return join(dataDir, 'bin', platform === 'win32' ? 'cloudflared.exe' : 'cloudflared')
}

export async function installCloudflared(options: CloudflaredInstallOptions): Promise<string> {
  const platform = options.platform ?? process.platform
  const destination = managedCloudflaredPath(options.dataDir, platform)
  if (isExecutable(destination, options.platform ?? process.platform)) return destination

  const arch = options.arch ?? process.arch
  const asset = options.asset ?? releaseAssetFor(platform, arch)
  if (!asset) throw new Error(`cloudflared is not available for ${platform}-${arch}`)

  const destinationDir = dirname(destination)
  mkdirSync(destinationDir, { recursive: true, mode: 0o700 })
  const lockPath = `${destination}.install.lock`
  acquireInstallLock(lockPath)
  const stagingDir = mkdtempSync(join(destinationDir, '.cloudflared-'))
  try {
    if (isExecutable(destination, platform)) return destination
    const response = await (options.fetchImpl ?? fetch)(asset.url, {
      headers: { 'user-agent': 'solus-cli' },
    })
    if (!response.ok) throw new Error(`cloudflared download failed: ${response.status} ${response.statusText}`)
    const bytes = Buffer.from(await response.arrayBuffer())
    const actual = createHash('sha256').update(bytes).digest('hex')
    if (actual !== asset.sha256) throw new Error('cloudflared checksum did not match the pinned release')

    const stagedBinary = join(stagingDir, basename(destination))
    if (asset.archive === 'binary') {
      writeFileSync(stagedBinary, bytes, { mode: 0o755 })
    } else {
      const archive = join(stagingDir, 'cloudflared.tgz')
      writeFileSync(archive, bytes, { mode: 0o600 })
      await runCommand('tar', ['-xzf', archive, '-C', stagingDir])
      const extracted = join(stagingDir, 'cloudflared')
      if (!existsSync(extracted)) throw new Error('cloudflared archive did not contain the binary')
      if (extracted !== stagedBinary) renameSync(extracted, stagedBinary)
      chmodSync(stagedBinary, 0o755)
    }

    await (options.validateBinary ?? validateCloudflared)(stagedBinary)
    renameSync(stagedBinary, destination)
    chmodSync(destination, 0o755)
    return destination
  } finally {
    rmSync(stagingDir, { recursive: true, force: true })
    rmSync(lockPath, { force: true })
  }
}

function releaseAssetFor(platform: NodeJS.Platform, arch: string): ReleaseAsset | undefined {
  switch (`${platform}-${arch}`) {
    case 'darwin-arm64': return RELEASE_ASSETS['darwin-arm64']
    case 'darwin-x64': return RELEASE_ASSETS['darwin-x64']
    case 'linux-arm64': return RELEASE_ASSETS['linux-arm64']
    case 'linux-x64': return RELEASE_ASSETS['linux-x64']
    default: return undefined
  }
}

function acquireInstallLock(lockPath: string): void {
  try {
    closeSync(openSync(lockPath, 'wx', 0o600))
    return
  } catch {
    try {
      if (Date.now() - statSync(lockPath).mtimeMs > 5 * 60_000) {
        rmSync(lockPath, { force: true })
        closeSync(openSync(lockPath, 'wx', 0o600))
        return
      }
    } catch {
      // The next error names the stable operator action.
    }
    throw new Error('another cloudflared installation is in progress')
  }
}

function isExecutable(path: string, platform: NodeJS.Platform): boolean {
  if (!existsSync(path)) return false
  if (platform === 'win32') return true
  return (statSync(path).mode & 0o111) !== 0
}

async function validateCloudflared(path: string): Promise<void> {
  await runCommand(path, ['version'])
}

function runCommand(command: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'ignore' })
    child.once('error', reject)
    child.once('exit', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`${command} exited with status ${code ?? 'unknown'}`))
    })
  })
}
