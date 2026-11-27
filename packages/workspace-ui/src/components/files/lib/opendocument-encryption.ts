import { cbc } from '@noble/ciphers/aes.js'
import { sha1 } from '@noble/hashes/legacy.js'
import { pbkdf2 } from '@noble/hashes/pbkdf2.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { SaxesParser } from 'saxes'
import {
  PROTECTED_PREVIEW_MAX_BYTES,
  ProtectedPreviewError,
} from './protected-preview-error'
import { ARCHIVE_MAX_XML_BYTES, type ZipArchiveEntry } from './zip-archive'

const MANIFEST_NS = 'urn:oasis:names:tc:opendocument:xmlns:manifest:1.0'
const MANIFEST_ALG_PREFIX = `${MANIFEST_NS}#`

const SUPPORTED_START_KEY_NAMES = new Set([
  'SHA1',
  'http://www.w3.org/2000/09/xmldsig#sha1',
  'http://www.w3.org/2000/09/xmldsig#sha256',
  'http://www.w3.org/2001/04/xmlenc#sha256',
])

const SUPPORTED_CHECKSUM_TYPES = new Set([
  'SHA1/1K',
  `${MANIFEST_ALG_PREFIX}sha1-1k`,
  `${MANIFEST_ALG_PREFIX}sha256-1k`,
])

function unsupported(): never {
  throw new ProtectedPreviewError('encryption-unsupported')
}

function invalid(): never {
  throw new ProtectedPreviewError('document-invalid')
}

function decodeBase64(value: string | undefined): Uint8Array {
  if (!value) invalid()
  try {
    return Uint8Array.from(atob(value), (char) => char.charCodeAt(0))
  } catch {
    invalid()
  }
}

async function inflateRaw(compressed: Uint8Array<ArrayBuffer>, size: number): Promise<Uint8Array<ArrayBuffer>> {
  const stream = new Blob([compressed]).stream().pipeThrough(new DecompressionStream('deflate-raw'))
  const reader = stream.getReader()
  const output = new Uint8Array(size)
  let length = 0
  try {
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      if (length + value.length > size) invalid()
      output.set(value, length)
      length += value.length
    }
    if (length !== size) invalid()
    return output
  } finally {
    void reader.cancel().catch(() => undefined)
  }
}

interface EncryptedOdfPart {
  path: string
  size: number
  iterations: number
  keyBytes: number
  iv: Uint8Array
  salt: Uint8Array
  expected: Uint8Array
  startHash: typeof sha1 | typeof sha256
  checksum: typeof sha1 | typeof sha256
}

interface PendingEntry {
  path?: string
  size?: string
  hasEncryption: boolean
  checksumType?: string
  checksum?: string
  algorithmName?: string
  iv?: string
  derivationName?: string
  iterations?: string
  salt?: string
  startKeyName?: string
}

function validateEncryptedEntry(entry: PendingEntry): EncryptedOdfPart {
  const keyBitsMatch = /^http:\/\/www\.w3\.org\/2001\/04\/xmlenc#aes(128|192|256)-cbc$/.exec(
    entry.algorithmName ?? '',
  )
  const keyBytes = keyBitsMatch ? Number(keyBitsMatch[1]) / 8 : Number.NaN
  const derivationValid =
    entry.derivationName === 'PBKDF2' || entry.derivationName === `${MANIFEST_ALG_PREFIX}pbkdf2`
  const startValid = !entry.startKeyName || SUPPORTED_START_KEY_NAMES.has(entry.startKeyName)
  const checksumValid = !!entry.checksumType && SUPPORTED_CHECKSUM_TYPES.has(entry.checksumType)
  if (!Number.isFinite(keyBytes) || !derivationValid || !startValid || !checksumValid) {
    unsupported()
  }
  const iterations = Number(entry.iterations)
  const size = Number(entry.size)
  if (!Number.isSafeInteger(iterations) || iterations < 1) invalid()
  if (!entry.path || !Number.isSafeInteger(size) || size < 0) invalid()
  return {
    path: entry.path,
    size,
    iterations,
    keyBytes,
    iv: decodeBase64(entry.iv),
    salt: decodeBase64(entry.salt),
    expected: decodeBase64(entry.checksum),
    startHash: entry.startKeyName?.endsWith('sha256') ? sha256 : sha1,
    checksum: entry.checksumType!.endsWith('sha256-1k') ? sha256 : sha1,
  }
}

function parseManifestEncryptedParts(xmlBytes: Uint8Array): EncryptedOdfPart[] {
  const parts: EncryptedOdfPart[] = []
  let current: PendingEntry | null = null
  const parser = new SaxesParser({ xmlns: true })
  parser.on('doctype', invalid)
  parser.on('error', invalid)
  parser.on('opentag', (tag) => {
    if (tag.uri !== MANIFEST_NS) return
    const attr = (local: string): string | undefined => {
      for (const item of Object.values(tag.attributes)) {
        if (item.uri === MANIFEST_NS && item.local === local) return item.value
      }
      return undefined
    }
    if (tag.local === 'file-entry') {
      current = { path: attr('full-path'), size: attr('size'), hasEncryption: false }
    } else if (current && tag.local === 'encryption-data') {
      current.hasEncryption = true
      current.checksumType = attr('checksum-type')
      current.checksum = attr('checksum')
    } else if (current?.hasEncryption && tag.local === 'algorithm') {
      current.algorithmName = attr('algorithm-name')
      current.iv = attr('initialisation-vector')
    } else if (current?.hasEncryption && tag.local === 'key-derivation') {
      current.derivationName = attr('key-derivation-name')
      current.iterations = attr('iteration-count')
      current.salt = attr('salt')
    } else if (current?.hasEncryption && tag.local === 'start-key-generation') {
      current.startKeyName = attr('start-key-generation-name')
    }
  })
  parser.on('closetag', (tag) => {
    if (tag.uri !== MANIFEST_NS || tag.local !== 'file-entry' || !current) return
    const entry = current
    current = null
    if (entry.hasEncryption) parts.push(validateEncryptedEntry(entry))
  })
  parser.write(new TextDecoder().decode(xmlBytes)).close()
  return parts
}

async function decryptOdfPart(
  part: EncryptedOdfPart,
  encrypted: Uint8Array | undefined,
  utf8Password: Uint8Array,
): Promise<Uint8Array<ArrayBuffer>> {
  if (
    !encrypted?.length ||
    encrypted.length % 16 !== 0 ||
    part.iv.length !== 16 ||
    part.salt.length > 64
  ) {
    invalid()
  }
  const key = pbkdf2(sha1, part.startHash(utf8Password), part.salt, {
    c: part.iterations,
    dkLen: part.keyBytes,
  })
  const padded = new Uint8Array(encrypted.length)
  cbc(key, part.iv, { disablePadding: true }).decrypt(encrypted, padded)
  const padding = padded.at(-1)!
  const compressed = padded.subarray(0, padded.length - padding)
  const hash = part.checksum(compressed.subarray(0, 1024))
  if (
    padding < 1 ||
    padding > 16 ||
    hash.length !== part.expected.length ||
    hash.some((value, index) => value !== part.expected[index])
  ) {
    throw new ProtectedPreviewError('password-incorrect')
  }
  return inflateRaw(compressed, part.size)
}

export async function unlockOpenDocument(
  files: Map<string, ZipArchiveEntry>,
  password?: string,
): Promise<void> {
  const manifestEntry = files.get('META-INF/manifest.xml')
  if (!manifestEntry?.bytes.length) return
  const parts = parseManifestEncryptedParts(manifestEntry.bytes)
  if (parts.length === 0) return
  if (parts.some((part) => part.path === 'encrypted-package')) unsupported()
  if (password === undefined) throw new ProtectedPreviewError('password-required')

  const total = parts.reduce((sum, part) => sum + part.size, 0)
  const rounds = parts.reduce(
    (sum, part) => sum + part.iterations * Math.ceil(part.keyBytes / 20),
    0,
  )
  if (rounds > 4_000_000 || parts.some((part) => part.iterations > 1_000_000)) {
    throw new ProtectedPreviewError('decryption-limit')
  }
  if (
    total > PROTECTED_PREVIEW_MAX_BYTES ||
    parts.some((part) => part.path.endsWith('.xml') && part.size > ARCHIVE_MAX_XML_BYTES)
  ) {
    throw new ProtectedPreviewError('archive-expanded-too-large')
  }

  const utf8 = new TextEncoder().encode(password)
  for (const part of parts) {
    const plain = await decryptOdfPart(part, files.get(part.path)?.bytes, utf8)
    files.set(part.path, {
      bytes: plain,
      directory: false,
      encrypted: false,
      size: plain.byteLength,
    })
  }
}
