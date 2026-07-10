import { createHash, randomUUID } from 'crypto'
import { createWriteStream, existsSync } from 'fs'
import { mkdir, readFile, rename, rm, writeFile } from 'fs/promises'
import { homedir } from 'os'
import { join } from 'path'
import { Readable } from 'stream'
import { pipeline } from 'stream/promises'
import { createLogger } from './logger'

const log = createLogger('main', 'model-downloader.ts')
const MODEL_NAME = 'parakeet-tdt-0.6b-v3-int8'
const MODEL_VERSION = 'v1'
const MODEL_BASE_URL = process.env.SOLUS_PARAKEET_MODEL_BASE_URL
  ?? `https://releases.solus.sh/models/${MODEL_NAME}/${MODEL_VERSION}`
const INSTALL_MARKER = '.installed'

const MODEL_FILES = [
  { name: 'nemo128.onnx', sha256: 'a9fde1486ebfcc08f328d75ad4610c67835fea58c73ba57e3209a6f6cf019e9f' },
  { name: 'encoder-model.int8.onnx', sha256: '6139d2fa7e1b086097b277c7149725edbab89cc7c7ae64b23c741be4055aff09' },
  { name: 'decoder_joint-model.int8.onnx', sha256: 'eea7483ee3d1a30375daedc8ed83e3960c91b098812127a0d99d1c8977667a70' },
  { name: 'vocab.txt', sha256: 'd58544679ea4bc6ac563d1f545eb7d474bd6cfa467f0a6e2c1dc1c7d37e3c35d' },
] as const

export const PARAKEET_MODEL_DIR = join(homedir(), '.solus', 'models', MODEL_NAME)

let installPromise: Promise<string> | null = null

async function isInstalled(): Promise<boolean> {
  try {
    const marker = await readFile(join(PARAKEET_MODEL_DIR, INSTALL_MARKER), 'utf8')
    return marker === MODEL_VERSION && MODEL_FILES.every(({ name }) => existsSync(join(PARAKEET_MODEL_DIR, name)))
  } catch {
    return false
  }
}

async function downloadFile(url: string, destination: string, expectedSha256: string): Promise<void> {
  const response = await fetch(url)
  if (!response.ok) throw new Error(`Download failed for ${url}: HTTP ${response.status}`)
  if (!response.body) throw new Error(`Download failed for ${url}: missing response body`)

  const hash = createHash('sha256')
  const source = Readable.fromWeb(response.body as import('stream/web').ReadableStream<Uint8Array>)
  source.on('data', (chunk: Buffer) => hash.update(chunk))
  await pipeline(source, createWriteStream(destination, { flags: 'wx' }))

  const actualSha256 = hash.digest('hex')
  if (actualSha256 !== expectedSha256) {
    throw new Error(`Checksum mismatch for ${url}`)
  }
}

async function downloadAndInstall(): Promise<string> {
  if (await isInstalled()) return PARAKEET_MODEL_DIR

  const modelsDir = join(homedir(), '.solus', 'models')
  const tempDir = join(modelsDir, `.${MODEL_NAME}-${randomUUID()}`)
  await mkdir(tempDir, { recursive: true })

  try {
    log.info(`Downloading ${MODEL_NAME} ${MODEL_VERSION}`)
    for (const file of MODEL_FILES) {
      await downloadFile(`${MODEL_BASE_URL}/${file.name}`, join(tempDir, file.name), file.sha256)
    }
    await writeFile(join(tempDir, INSTALL_MARKER), MODEL_VERSION, 'utf8')
    await rm(PARAKEET_MODEL_DIR, { recursive: true, force: true })
    await rename(tempDir, PARAKEET_MODEL_DIR)
    log.info(`Installed ${MODEL_NAME} ${MODEL_VERSION}`)
    return PARAKEET_MODEL_DIR
  } catch (err) {
    await rm(tempDir, { recursive: true, force: true })
    throw err
  }
}

export function ensureParakeetModel(): Promise<string> {
  if (!installPromise) {
    installPromise = downloadAndInstall().catch((err) => {
      installPromise = null
      throw err
    })
  }
  return installPromise
}
