import {
  ERR_ENCRYPTED,
  ERR_INVALID_COMPRESSED_DATA,
  ERR_INVALID_CRC32,
  ERR_INVALID_PASSWORD,
  ERR_INVALID_UNCOMPRESSED_SIZE,
  ERR_UNSUPPORTED_COMPRESSION,
  ERR_UNSUPPORTED_ENCRYPTION,
  Uint8ArrayReader,
  ZipReader,
  type FileEntry,
} from '@zip.js/zip.js'
import {
  PROTECTED_PREVIEW_MAX_BYTES,
  ProtectedPreviewError,
} from './protected-preview-error'

export const ARCHIVE_MAX_ENTRIES = 2048
export const ARCHIVE_MAX_RATIO = 200
export const ARCHIVE_MAX_XML_BYTES = 8 * 1024 * 1024

export interface ZipArchiveEntry {
  bytes: Uint8Array<ArrayBuffer>
  directory: boolean
  encrypted: boolean
  size: number
}

export interface ZipDirectoryInfo {
  encrypted: boolean
}

interface EocdBounds {
  count: number
  directorySize: number
  directoryOffset: number
  directoryEnd: number
}

function readZip64Bounds(
  view: DataView,
  byteLength: number,
  eocdOffset: number,
  entryLimit: number,
): EocdBounds {
  const locator = eocdOffset - 20
  const record = locator - 56
  for (let candidate = byteLength - 4; candidate > locator; candidate--) {
    if (view.getUint32(candidate, true) === 0x07064b50) {
      throw new ProtectedPreviewError('archive-invalid')
    }
  }
  const headerValid =
    record >= 0 &&
    view.getUint32(locator, true) === 0x07064b50 &&
    view.getUint32(record, true) === 0x06064b50 &&
    view.getBigUint64(record + 4, true) === 44n &&
    view.getUint32(record + 16, true) === 0 &&
    view.getUint32(record + 20, true) === 0 &&
    view.getUint32(locator + 4, true) === 0 &&
    view.getUint32(locator + 16, true) === 1 &&
    view.getBigUint64(locator + 8, true) === BigInt(record)
  if (!headerValid) throw new ProtectedPreviewError('archive-invalid')
  const records = view.getBigUint64(record + 32, true)
  const size = view.getBigUint64(record + 40, true)
  const start = view.getBigUint64(record + 48, true)
  if (
    records > BigInt(entryLimit) ||
    size > BigInt(record) ||
    start > BigInt(record) ||
    view.getBigUint64(locator + 8, true) !== start + size ||
    view.getBigUint64(record + 24, true) !== records
  ) {
    throw new ProtectedPreviewError('archive-invalid')
  }
  return {
    count: Number(records),
    directorySize: Number(size),
    directoryOffset: Number(start),
    directoryEnd: record,
  }
}

function locateEocd(view: DataView, byteLength: number, entryLimit: number): EocdBounds {
  for (let offset = byteLength - 22; offset >= Math.max(0, byteLength - 65557); offset--) {
    if (view.getUint32(offset, true) !== 0x06054b50) continue
    if (offset + 22 + view.getUint16(offset + 20, true) !== byteLength) {
      throw new ProtectedPreviewError('archive-invalid')
    }
    const rawCount = view.getUint16(offset + 10, true)
    const rawSize = view.getUint32(offset + 12, true)
    const rawOffset = view.getUint32(offset + 16, true)
    const isZip64 =
      [4, 6, 8, 10].some((field) => view.getUint16(offset + field, true) === 0xffff) ||
      rawSize === 0xffffffff ||
      rawOffset === 0xffffffff
    const bounds = isZip64
      ? readZip64Bounds(view, byteLength, offset, entryLimit)
      : { count: rawCount, directorySize: rawSize, directoryOffset: rawOffset, directoryEnd: offset }
    if (bounds.count > entryLimit) throw new ProtectedPreviewError('archive-too-many-entries')
    if (bounds.directoryOffset > bounds.directoryEnd - bounds.directorySize) {
      throw new ProtectedPreviewError('archive-invalid')
    }
    return bounds
  }
  throw new ProtectedPreviewError('archive-invalid')
}

export function checkZipDirectory(bytes: ArrayBuffer, entryLimit = ARCHIVE_MAX_ENTRIES): ZipDirectoryInfo {
  const view = new DataView(bytes)
  const { directoryEnd, directorySize } = locateEocd(view, bytes.byteLength, entryLimit)
  if (directoryEnd < 0 || directorySize > directoryEnd) {
    throw new ProtectedPreviewError('archive-invalid')
  }
  let records = 0
  let encrypted = false
  for (let offset = directoryEnd - directorySize; offset < directoryEnd;) {
    if (offset + 46 > directoryEnd || view.getUint32(offset, true) !== 0x02014b50) {
      throw new ProtectedPreviewError('archive-invalid')
    }
    if (++records > entryLimit) throw new ProtectedPreviewError('archive-too-many-entries')
    encrypted ||= (view.getUint16(offset + 8, true) & 1) !== 0
    const nameLength = view.getUint16(offset + 28, true)
    if (nameLength > 1024) throw new ProtectedPreviewError('archive-path-too-long')
    offset += 46 + nameLength + view.getUint16(offset + 30, true) + view.getUint16(offset + 32, true)
    if (offset > directoryEnd) throw new ProtectedPreviewError('archive-invalid')
  }
  return { encrypted }
}

function normalizeEntryName(entryName: string): string {
  const parts: string[] = []
  for (const part of entryName.split('/')) {
    if (part === '..') parts.pop()
    else if (part && part !== '.') parts.push(part)
  }
  return parts.join('/')
}

interface ZipEntryReadOptions {
  password?: string
  checkCrc32: boolean
  checkAuthenticationCode: boolean
  signal?: AbortSignal
}

async function readZipEntry(
  entry: FileEntry,
  password: string | undefined,
  signal?: AbortSignal,
): Promise<Uint8Array<ArrayBuffer>> {
  const content = new Uint8Array(entry.uncompressedSize)
  let offset = 0
  const dataOptions: ZipEntryReadOptions = {
    checkCrc32: true,
    checkAuthenticationCode: true,
  }
  if (entry.encrypted && password !== undefined) dataOptions.password = password
  if (signal) dataOptions.signal = signal
  try {
    await entry.getData(
      new WritableStream<Uint8Array>({
        write(chunk) {
          if (offset + chunk.length > content.length) {
            throw new ProtectedPreviewError('archive-expanded-too-large')
          }
          content.set(chunk, offset)
          offset += chunk.length
        },
      }),
      dataOptions,
    )
  } catch (cause) {
    if (cause instanceof ProtectedPreviewError) throw cause
    if (
      entry.encrypted &&
      entry.zipCrypto &&
      cause instanceof Error &&
      [ERR_INVALID_CRC32, ERR_INVALID_COMPRESSED_DATA, ERR_INVALID_UNCOMPRESSED_SIZE].includes(
        cause.message,
      )
    ) {
      throw new ProtectedPreviewError('password-incorrect')
    }
    throw cause
  }
  return content
}

function mapZipReadError(cause: unknown): never {
  if (cause instanceof ProtectedPreviewError) throw cause
  if (cause instanceof Error) {
    if (cause.message === ERR_INVALID_PASSWORD || cause.message === ERR_ENCRYPTED) {
      throw new ProtectedPreviewError('password-incorrect')
    }
    if (
      cause.message === ERR_UNSUPPORTED_ENCRYPTION ||
      cause.message === ERR_UNSUPPORTED_COMPRESSION
    ) {
      throw new ProtectedPreviewError('encryption-unsupported')
    }
  }
  throw new ProtectedPreviewError('archive-invalid')
}

export interface ReadBoundedZipOptions {
  password?: string
  maxBytes?: number
  maxEntries?: number
  maxEntryBytes?: number
  maxXmlBytes?: number
  signal?: AbortSignal
}

function assertZipEntryBounds(
  name: string,
  entrySize: number,
  total: number,
  limits: { totalLimit: number; maxEntryBytes: number; maxXmlBytes: number },
): void {
  if (
    total > limits.totalLimit ||
    entrySize > limits.maxEntryBytes ||
    (name.toLowerCase().endsWith('.xml') && entrySize > limits.maxXmlBytes)
  ) {
    throw new ProtectedPreviewError('archive-expanded-too-large')
  }
}

export async function readBoundedZip(
  bytes: ArrayBuffer,
  options: ReadBoundedZipOptions = {},
): Promise<Map<string, ZipArchiveEntry>> {
  const maxBytes = options.maxBytes ?? PROTECTED_PREVIEW_MAX_BYTES
  const maxEntries = options.maxEntries ?? ARCHIVE_MAX_ENTRIES
  const limits = {
    totalLimit: Math.min(maxBytes, Math.max(1024 * 1024, bytes.byteLength * ARCHIVE_MAX_RATIO)),
    maxEntryBytes: options.maxEntryBytes ?? maxBytes,
    maxXmlBytes: options.maxXmlBytes ?? ARCHIVE_MAX_XML_BYTES,
  }
  if (bytes.byteLength > PROTECTED_PREVIEW_MAX_BYTES) {
    throw new ProtectedPreviewError('file-too-large')
  }
  const { encrypted } = checkZipDirectory(bytes, maxEntries)
  if (encrypted && options.password === undefined) {
    throw new ProtectedPreviewError('password-required')
  }
  const reader = new ZipReader(new Uint8ArrayReader(new Uint8Array(bytes)), {
    useWebWorkers: false,
  })
  const files = new Map<string, ZipArchiveEntry>()
  let total = 0
  try {
    const entries = await reader.getEntries()
    if (entries.length > maxEntries) throw new ProtectedPreviewError('archive-too-many-entries')
    for (const entry of entries) {
      options.signal?.throwIfAborted()
      if (entry.filename.length > 1024) throw new ProtectedPreviewError('archive-path-too-long')
      const name = normalizeEntryName(entry.filename)
      if (!name) continue
      total += entry.uncompressedSize
      assertZipEntryBounds(name, entry.uncompressedSize, total, limits)
      const content = entry.directory
        ? new Uint8Array(0)
        : await readZipEntry(entry, options.password, options.signal)
      files.set(entry.directory ? `${name}/` : name, {
        bytes: content,
        directory: entry.directory,
        encrypted: entry.encrypted,
        size: content.byteLength,
      })
    }
    return files
  } catch (cause) {
    mapZipReadError(cause)
  } finally {
    await reader.close()
  }
}

export function decodeUtf8Preview(
  bytes: Uint8Array,
  maxBytes = 1024 * 1024,
): { text: string; truncated: boolean } | null {
  const slice = bytes.subarray(0, maxBytes)
  for (let i = 0; i < Math.min(slice.length, 8000); i++) {
    if (slice[i] === 0) return null
  }
  try {
    const decoder = new TextDecoder('utf-8', { fatal: true })
    return {
      text: decoder.decode(slice, { stream: bytes.length > maxBytes }),
      truncated: bytes.length > maxBytes,
    }
  } catch {
    return null
  }
}
