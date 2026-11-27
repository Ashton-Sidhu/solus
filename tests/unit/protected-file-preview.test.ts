import { describe, expect, it } from 'bun:test'
import { cbc, ecb } from '@noble/ciphers/aes.js'
import { hmac } from '@noble/hashes/hmac.js'
import { sha1 } from '@noble/hashes/legacy.js'
import { pbkdf2 } from '@noble/hashes/pbkdf2.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { concatBytes } from '@noble/hashes/utils.js'
import { TextReader, Uint8ArrayReader, Uint8ArrayWriter, ZipWriter } from '@zip.js/zip.js'
import { AssetUrlCache } from '../../packages/workspace-ui/src/components/artifact/lib/asset-url'
import { openProtectedDocument } from '../../packages/workspace-ui/src/components/files/lib/document-preview'
import { unlockOpenDocument } from '../../packages/workspace-ui/src/components/files/lib/opendocument-encryption'
import {
  ProtectedPreviewError,
  protectedPreviewKind,
} from '../../packages/workspace-ui/src/components/files/lib/protected-preview-error'
import { decodeUtf8Preview, readBoundedZip } from '../../packages/workspace-ui/src/components/files/lib/zip-archive'

const NO_PADDING = { disablePadding: true }

function uint32(n: number): Uint8Array {
  const bytes = new Uint8Array(4)
  new DataView(bytes.buffer).setUint32(0, n, true)
  return bytes
}

function pad36(bytes: Uint8Array, length: number): Uint8Array {
  const output = new Uint8Array(length).fill(0x36)
  output.set(bytes.subarray(0, length))
  return output
}

function toBase64(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}

async function deflateRaw(bytes: Uint8Array<ArrayBuffer>): Promise<Uint8Array<ArrayBuffer>> {
  const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate-raw'))
  return new Uint8Array(await new Response(stream).arrayBuffer())
}

async function makeZip(
  entries: Array<{ name: string; content: string | Uint8Array; password?: string; zipCrypto?: boolean }>,
): Promise<ArrayBuffer> {
  const writer = new ZipWriter(new Uint8ArrayWriter(), { useWebWorkers: false })
  for (const entry of entries) {
    const reader =
      typeof entry.content === 'string'
        ? new TextReader(entry.content)
        : new Uint8ArrayReader(entry.content)
    await writer.add(entry.name, reader, {
      ...(entry.password ? { password: entry.password, zipCrypto: entry.zipCrypto === true } : {}),
    })
  }
  return (await writer.close()).buffer
}

/** Build a minimal valid MS-CFB v3 (512-byte sectors) container holding EncryptionInfo and EncryptedPackage. */
function buildCfb(info: Uint8Array, pkg: Uint8Array): ArrayBuffer {
  const SECTOR = 512
  const MINI = 64
  const END = 0xfffffffe
  const FREE = 0xffffffff
  const FAT_SECT = 0xfffffffd

  // Put both streams in regular FAT sectors when >= 4096, or in the mini-stream when < 4096.
  const miniEntries: Array<{ data: Uint8Array; startMini: number }> = []
  let miniSectorCursor = 0
  const allocMini = (data: Uint8Array): number => {
    const start = miniSectorCursor
    miniSectorCursor += Math.ceil(data.length / MINI)
    miniEntries.push({ data, startMini: start })
    return start
  }

  const infoIsMini = info.length < 4096
  const pkgIsMini = pkg.length < 4096
  const infoMiniStart = infoIsMini ? allocMini(info) : 0
  const pkgMiniStart = pkgIsMini ? allocMini(pkg) : 0

  const miniStreamBytes = miniSectorCursor * MINI
  const miniStreamSectors = miniStreamBytes > 0 ? Math.ceil(miniStreamBytes / SECTOR) : 0
  const miniFatSectors = miniStreamSectors > 0 ? 1 : 0
  const infoRegSectors = infoIsMini ? 0 : Math.ceil(info.length / SECTOR)
  const pkgRegSectors = pkgIsMini ? 0 : Math.ceil(pkg.length / SECTOR)

  // Sector map:
  // 0: FAT
  // 1: Directory
  // next: miniFAT (if needed)
  // next: miniStream (if needed)
  // next: info (if regular)
  // next: pkg (if regular)
  let nextSector = 2
  const miniFatStart = miniFatSectors ? nextSector : END
  nextSector += miniFatSectors
  const miniStreamStart = miniStreamSectors ? nextSector : END
  nextSector += miniStreamSectors
  const infoRegStart = infoRegSectors ? nextSector : END
  nextSector += infoRegSectors
  const pkgRegStart = pkgRegSectors ? nextSector : END
  nextSector += pkgRegSectors

  const totalSectors = nextSector
  const output = new Uint8Array((1 + totalSectors) * SECTOR)
  const view = new DataView(output.buffer)

  // Header
  output.set([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1], 0)
  view.setUint16(24, 0x003e, true)
  view.setUint16(26, 3, true)
  view.setUint16(28, 0xfffe, true)
  view.setUint16(30, 9, true)
  view.setUint16(32, 6, true)
  view.setUint32(44, 1, true) // 1 FAT sector
  view.setUint32(48, 1, true) // directory start sector = 1
  view.setUint32(56, 4096, true) // mini stream cutoff
  view.setUint32(60, miniFatStart, true)
  view.setUint32(64, miniFatSectors, true)
  view.setUint32(68, END, true)
  view.setUint32(72, 0, true)
  for (let i = 0; i < 109; i++) view.setUint32(76 + i * 4, i === 0 ? 0 : FREE, true)

  // FAT sector (sector 0)
  const fatOffset = SECTOR
  for (let i = 0; i < SECTOR / 4; i++) view.setUint32(fatOffset + i * 4, FREE, true)
  const linkChain = (start: number, count: number) => {
    for (let i = 0; i < count; i++) {
      view.setUint32(fatOffset + (start + i) * 4, i === count - 1 ? END : start + i + 1, true)
    }
  }
  view.setUint32(fatOffset + 0 * 4, FAT_SECT, true)
  view.setUint32(fatOffset + 1 * 4, END, true)
  if (miniFatSectors) linkChain(miniFatStart, miniFatSectors)
  if (miniStreamSectors) linkChain(miniStreamStart, miniStreamSectors)
  if (infoRegSectors) linkChain(infoRegStart, infoRegSectors)
  if (pkgRegSectors) linkChain(pkgRegStart, pkgRegSectors)

  // MiniFAT & MiniStream
  if (miniFatSectors) {
    const miniFatOffset = (1 + miniFatStart) * SECTOR
    for (let i = 0; i < SECTOR / 4; i++) view.setUint32(miniFatOffset + i * 4, FREE, true)
    const miniStreamOffset = (1 + miniStreamStart) * SECTOR
    for (const entry of miniEntries) {
      const count = Math.ceil(entry.data.length / MINI)
      for (let i = 0; i < count; i++) {
        view.setUint32(
          miniFatOffset + (entry.startMini + i) * 4,
          i === count - 1 ? END : entry.startMini + i + 1,
          true,
        )
      }
      output.set(entry.data, miniStreamOffset + entry.startMini * MINI)
    }
  }
  if (infoRegSectors) output.set(info, (1 + infoRegStart) * SECTOR)
  if (pkgRegSectors) output.set(pkg, (1 + pkgRegStart) * SECTOR)

  // Directory sector (sector 1)
  const dirOffset = 2 * SECTOR
  const writeDirEntry = (
    index: number,
    name: string,
    type: number,
    left: number,
    right: number,
    child: number,
    start: number,
    size: number,
  ) => {
    const base = dirOffset + index * 128
    for (let i = 0; i < name.length; i++) view.setUint16(base + i * 2, name.charCodeAt(i), true)
    view.setUint16(base + name.length * 2, 0, true)
    view.setUint16(base + 64, (name.length + 1) * 2, true)
    view.setUint8(base + 66, type)
    view.setUint8(base + 67, 1)
    view.setUint32(base + 68, left, true)
    view.setUint32(base + 72, right, true)
    view.setUint32(base + 76, child, true)
    view.setUint32(base + 116, start, true)
    view.setBigUint64(base + 120, BigInt(size), true)
  }
  writeDirEntry(0, 'Root Entry', 5, FREE, FREE, 1, miniStreamStart, miniStreamBytes)
  writeDirEntry(1, 'EncryptionInfo', 2, FREE, 2, FREE, infoIsMini ? infoMiniStart : infoRegStart, info.length)
  writeDirEntry(2, 'EncryptedPackage', 2, FREE, FREE, FREE, pkgIsMini ? pkgMiniStart : pkgRegStart, pkg.length)

  return output.buffer
}

function officePasswordHash(
  hash: typeof sha1 | typeof sha256,
  salt: Uint8Array,
  password: string,
  spins: number,
): Uint8Array {
  const utf16 = new Uint8Array(password.length * 2)
  const view = new DataView(utf16.buffer)
  for (let i = 0; i < password.length; i++) view.setUint16(i * 2, password.charCodeAt(i), true)
  const block = new Uint8Array(4 + hash.outputLen)
  const counter = new DataView(block.buffer)
  block.set(hash(concatBytes(salt, utf16)), 4)
  for (let i = 0; i < spins; i++) {
    counter.setUint32(0, i, true)
    block.set(hash(block), 4)
  }
  return block.subarray(4)
}

function encryptOfficeAgile(plainZip: ArrayBuffer, password: string, spins = 100): ArrayBuffer {
  const plain = new Uint8Array(plainZip)
  const dataSalt = new Uint8Array(16).fill(0x11)
  const keySalt = new Uint8Array(16).fill(0x22)
  const dataKey = new Uint8Array(32).fill(0x33)
  const verifierInput = new Uint8Array(16).fill(0x44)
  const hmacKeyPlain = new Uint8Array(32).fill(0x55)

  const secret = officePasswordHash(sha256, keySalt, password, spins)
  const encryptKeyVal = (value: Uint8Array, block: number[]) => {
    const aesKey = pad36(sha256(concatBytes(secret, new Uint8Array(block))), 32)
    return cbc(aesKey, pad36(keySalt, 16), NO_PADDING).encrypt(value)
  }
  const encVerifierInput = encryptKeyVal(verifierInput, [0xfe, 0xa7, 0xd2, 0x76, 0x3b, 0x4b, 0x9e, 0x79])
  const encVerifierValue = encryptKeyVal(sha256(verifierInput), [0xd7, 0xaa, 0x0f, 0x6d, 0x30, 0x61, 0x34, 0x4e])
  const encKeyValue = encryptKeyVal(dataKey, [0x14, 0x6e, 0x0b, 0xe7, 0xab, 0xac, 0xd0, 0xd6])

  const encryptSegment = (block: Uint8Array, value: Uint8Array) =>
    cbc(dataKey, pad36(sha256(concatBytes(dataSalt, block)), 16), NO_PADDING).encrypt(value)

  const paddedLen = Math.ceil(plain.length / 16) * 16
  const pkg = new Uint8Array(8 + paddedLen)
  new DataView(pkg.buffer).setBigUint64(0, BigInt(plain.length), true)
  for (let offset = 0; offset < plain.length; offset += 4096) {
    const slice = plain.subarray(offset, Math.min(plain.length, offset + 4096))
    const segLen = Math.ceil(slice.length / 16) * 16
    const seg = new Uint8Array(segLen)
    seg.set(slice)
    pkg.set(encryptSegment(uint32(offset / 4096), seg), 8 + offset)
  }

  const encHmacKey = encryptSegment(new Uint8Array([0x5f, 0xb2, 0xad, 0x01, 0x0c, 0xb9, 0xe1, 0xf6]), hmacKeyPlain)
  const hmacDigest = hmac(sha256, hmacKeyPlain, pkg)
  const encHmacValue = encryptSegment(new Uint8Array([0xa0, 0x67, 0x7f, 0x02, 0xb2, 0x2c, 0x84, 0x33]), hmacDigest)

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<encryption xmlns="http://schemas.microsoft.com/office/2006/encryption" xmlns:p="http://schemas.microsoft.com/office/2006/keyEncryptor/password">
  <keyData saltSize="16" blockSize="16" keyBits="256" hashSize="32" cipherAlgorithm="AES" cipherChaining="ChainingModeCBC" hashAlgorithm="SHA256" saltValue="${toBase64(dataSalt)}"/>
  <dataIntegrity encryptedHmacKey="${toBase64(encHmacKey)}" encryptedHmacValue="${toBase64(encHmacValue)}"/>
  <keyEncryptors><keyEncryptor uri="http://schemas.microsoft.com/office/2006/keyEncryptor/password">
    <p:encryptedKey spinCount="${spins}" saltSize="16" blockSize="16" keyBits="256" hashSize="32" cipherAlgorithm="AES" cipherChaining="ChainingModeCBC" hashAlgorithm="SHA256" saltValue="${toBase64(keySalt)}" encryptedVerifierHashInput="${toBase64(encVerifierInput)}" encryptedVerifierHashValue="${toBase64(encVerifierValue)}" encryptedKeyValue="${toBase64(encKeyValue)}"/>
  </keyEncryptor></keyEncryptors>
</encryption>`
  const xmlBytes = new TextEncoder().encode(xml)
  const info = new Uint8Array(8 + xmlBytes.length)
  const headerView = new DataView(info.buffer)
  headerView.setUint16(0, 4, true)
  headerView.setUint16(2, 4, true)
  headerView.setUint32(4, 0x40, true)
  info.set(xmlBytes, 8)
  return buildCfb(info, pkg)
}

function encryptOfficeStandard(plainZip: ArrayBuffer, password: string): ArrayBuffer {
  const plain = new Uint8Array(plainZip)
  const salt = new Uint8Array(16).fill(0x2a)
  const verifierPlain = new Uint8Array(16).fill(0x7c)
  const secret = officePasswordHash(sha1, salt, password, 50_000)
  const hash = sha1(concatBytes(secret, uint32(0)))
  const key = concatBytes(
    ...[0x36, 0x5c].map((byte) => {
      const block = new Uint8Array(64).fill(byte)
      hash.forEach((value, i) => {
        block[i] = value ^ byte
      })
      return sha1(block)
    }),
  ).subarray(0, 16)

  const verifierEnc = ecb(key, NO_PADDING).encrypt(verifierPlain)
  const verifierHashPadded = new Uint8Array(32)
  verifierHashPadded.set(sha1(verifierPlain))
  const digestEnc = ecb(key, NO_PADDING).encrypt(verifierHashPadded)

  const info = new Uint8Array(44 + 72)
  const view = new DataView(info.buffer)
  view.setUint16(0, 3, true)
  view.setUint16(2, 2, true)
  view.setUint32(4, 0x24, true)
  view.setUint32(8, 32, true) // header size -> verifierOffset = 44
  view.setUint32(20, 0x660e, true) // AES-128
  view.setUint32(24, 0x8004, true) // SHA-1
  view.setUint32(28, 128, true) // keyBits
  view.setUint32(44, 16, true) // saltSize
  info.set(salt, 48)
  info.set(verifierEnc, 64)
  view.setUint32(80, 20, true) // verifierHashSize
  info.set(digestEnc, 84)

  const paddedLen = Math.ceil(plain.length / 16) * 16
  const paddedPlain = new Uint8Array(paddedLen)
  paddedPlain.set(plain)
  const pkg = new Uint8Array(8 + paddedLen)
  new DataView(pkg.buffer).setBigUint64(0, BigInt(plain.length), true)
  pkg.set(ecb(key, NO_PADDING).encrypt(paddedPlain), 8)
  return buildCfb(info, pkg)
}

async function encryptOdf(contentXml: string, password: string): Promise<ArrayBuffer> {
  const plain = new TextEncoder().encode(contentXml)
  const compressed = await deflateRaw(plain)
  const salt = new Uint8Array(16).fill(0x61)
  const iv = new Uint8Array(16).fill(0x62)
  const iterations = 100
  const startKey = sha256(new TextEncoder().encode(password))
  const key = pbkdf2(sha1, startKey, salt, { c: iterations, dkLen: 32 })
  const padLen = 16 - (compressed.length % 16)
  const padded = new Uint8Array(compressed.length + padLen)
  padded.set(compressed)
  padded.fill(padLen, compressed.length)
  const ciphertext = cbc(key, iv, NO_PADDING).encrypt(padded)
  const checksum = sha256(compressed.subarray(0, 1024))
  const manifest = `<?xml version="1.0" encoding="UTF-8"?>
<m:manifest xmlns:m="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0">
  <m:file-entry m:full-path="content.xml" m:media-type="text/xml" m:size="${plain.length}">
    <m:encryption-data m:checksum-type="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0#sha256-1k" m:checksum="${toBase64(checksum)}">
      <m:algorithm m:algorithm-name="http://www.w3.org/2001/04/xmlenc#aes256-cbc" m:initialisation-vector="${toBase64(iv)}"/>
      <m:key-derivation m:key-derivation-name="PBKDF2" m:iteration-count="${iterations}" m:salt="${toBase64(salt)}"/>
      <m:start-key-generation m:start-key-generation-name="http://www.w3.org/2000/09/xmldsig#sha256"/>
    </m:encryption-data>
  </m:file-entry>
</m:manifest>`
  return makeZip([
    { name: 'META-INF/manifest.xml', content: manifest },
    { name: 'content.xml', content: ciphertext },
  ])
}

describe('protected file previews', () => {
  it('classifies supported protected preview extensions', () => {
    expect(protectedPreviewKind('/tmp/archive.zip')).toBe('zip')
    expect(protectedPreviewKind('/tmp/report.DOCX')).toBe('docx')
    expect(protectedPreviewKind('/tmp/budget.xlsx')).toBe('xlsx')
    expect(protectedPreviewKind('/tmp/deck.pptx')).toBe('pptx')
    expect(protectedPreviewKind('/tmp/notes.odt')).toBe('odt')
    expect(protectedPreviewKind('/tmp/sheet.ods')).toBe('ods')
    expect(protectedPreviewKind('/tmp/slides.odp')).toBe('odp')
    expect(protectedPreviewKind('/tmp/book.epub')).toBe('epub')
    expect(protectedPreviewKind('/tmp/photo.png')).toBeNull()
  })

  it.each([false, true])('unlocks AES and ZipCrypto ZIP archives (zipCrypto: %s)', async (zipCrypto) => {
    const bytes = await makeZip([
      { name: 'public.txt', content: 'Public note' },
      { name: 'secret.txt', content: 'Unlocked ZIP payload', password: 'open me', zipCrypto },
    ])
    await expect(readBoundedZip(bytes)).rejects.toMatchObject({ code: 'password-required' })
    let wrongError: unknown
    try {
      await readBoundedZip(bytes, { password: 'wrong-secret-password' })
    } catch (error) {
      wrongError = error
    }
    expect(wrongError).toBeInstanceOf(ProtectedPreviewError)
    expect((wrongError as ProtectedPreviewError).code).toBe('password-incorrect')
    expect((wrongError as ProtectedPreviewError).message).not.toContain('wrong-secret-password')

    const files = await readBoundedZip(bytes, { password: 'open me' })
    expect(decodeUtf8Preview(files.get('public.txt')!.bytes)?.text).toBe('Public note')
    expect(decodeUtf8Preview(files.get('secret.txt')!.bytes)?.text).toBe('Unlocked ZIP payload')
  })

  it('unlocks Agile AES-256-CBC encrypted DOCX and retries wrong password', async () => {
    const plainDocx = await makeZip([
      {
        name: 'word/document.xml',
        content: `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
          <w:body>
            <w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Confidential</w:t></w:r></w:p>
            <w:p><w:r><w:t>Unlocked Word content</w:t></w:r></w:p>
          </w:body>
        </w:document>`,
      },
    ])
    const encrypted = encryptOfficeAgile(plainDocx, 'open me')
    await expect(openProtectedDocument('docx', encrypted)).rejects.toMatchObject({ code: 'password-required' })
    await expect(openProtectedDocument('docx', encrypted, 'wrong')).rejects.toMatchObject({ code: 'password-incorrect' })
    const decoded = await openProtectedDocument('docx', encrypted, 'open me')
    expect(decoded).toEqual({
      kind: 'document',
      blocks: [
        { kind: 'heading', level: 1, text: 'Confidential' },
        { kind: 'paragraph', text: 'Unlocked Word content' },
      ],
    })
  })

  it('unlocks Standard AES-128-ECB encrypted XLSX', async () => {
    const plainXlsx = await makeZip([
      {
        name: 'xl/workbook.xml',
        content: '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Summary" sheetId="1" r:id="rId1"/></sheets></workbook>',
      },
      {
        name: 'xl/_rels/workbook.xml.rels',
        content: '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>',
      },
      {
        name: 'xl/sharedStrings.xml',
        content: '<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><si><t>Unlocked Sheet</t></si></sst>',
      },
      {
        name: 'xl/worksheets/sheet1.xml',
        content: '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1"><v>42</v></c></row></sheetData></worksheet>',
      },
    ])
    const encrypted = encryptOfficeStandard(plainXlsx, 'open me')
    await expect(openProtectedDocument('xlsx', encrypted)).rejects.toMatchObject({ code: 'password-required' })
    await expect(openProtectedDocument('xlsx', encrypted, 'wrong')).rejects.toMatchObject({ code: 'password-incorrect' })
    const decoded = await openProtectedDocument('xlsx', encrypted, 'open me')
    expect(decoded).toEqual({
      kind: 'spreadsheet',
      sheets: [{ name: 'Summary', rows: [['Unlocked Sheet', '42']], truncated: false }],
    })
  })

  it('unlocks Agile encrypted PPTX', async () => {
    const plainPptx = await makeZip([
      {
        name: 'ppt/slides/slide1.xml',
        content: '<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>Unlocked Slide</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>',
      },
    ])
    const encrypted = encryptOfficeAgile(plainPptx, 'open me')
    await expect(openProtectedDocument('pptx', encrypted)).rejects.toMatchObject({ code: 'password-required' })
    const decoded = await openProtectedDocument('pptx', encrypted, 'open me')
    expect(decoded).toEqual({
      kind: 'presentation',
      slides: [{ index: 1, lines: ['Unlocked Slide'] }],
    })
  })

  it('unlocks AES-256-CBC encrypted OpenDocument (ODT, ODS, ODP) and enforces round limits', async () => {
    const odt = await encryptOdf(
      '<office:document-content xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0"><office:body><office:text><text:h text:outline-level="1">Title</text:h><text:p>Unlocked Writer</text:p></office:text></office:body></office:document-content>',
      'open me',
    )
    await expect(openProtectedDocument('odt', odt)).rejects.toMatchObject({ code: 'password-required' })
    await expect(openProtectedDocument('odt', odt, 'wrong')).rejects.toMatchObject({ code: 'password-incorrect' })
    expect(await openProtectedDocument('odt', odt, 'open me')).toEqual({
      kind: 'document',
      blocks: [
        { kind: 'heading', level: 1, text: 'Title' },
        { kind: 'paragraph', text: 'Unlocked Writer' },
      ],
    })

    const parts = Array.from(
      { length: 3 },
      (_, index) => `<m:file-entry m:full-path="part-${index}.xml" m:size="1">
        <m:encryption-data m:checksum-type="SHA1/1K" m:checksum="AA==">
          <m:algorithm m:algorithm-name="http://www.w3.org/2001/04/xmlenc#aes256-cbc" m:initialisation-vector="AA=="/>
          <m:key-derivation m:key-derivation-name="PBKDF2" m:iteration-count="1000000" m:salt="AA=="/>
        </m:encryption-data>
      </m:file-entry>`,
    )
    const highWorkManifest = new TextEncoder().encode(
      `<m:manifest xmlns:m="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0">${parts.join('')}</m:manifest>`,
    )
    const files = new Map([
      ['META-INF/manifest.xml', { bytes: highWorkManifest, directory: false, encrypted: false, size: highWorkManifest.length }],
    ])
    await expect(unlockOpenDocument(files, 'open me')).rejects.toMatchObject({ code: 'decryption-limit' })
  })

  it('unlocks ZIP-encrypted EPUB and rejects DRM-protected EPUBs', async () => {
    const epubEntries = [
      {
        name: 'META-INF/container.xml',
        content: '<container><rootfiles><rootfile full-path="book.opf"/></rootfiles></container>',
        password: 'open me',
      },
      {
        name: 'book.opf',
        content: '<package xmlns:dc="http://purl.org/dc/elements/1.1/"><metadata><dc:title>Locked Book</dc:title></metadata><manifest><item id="ch1" href="chapter1.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="ch1"/></spine></package>',
        password: 'open me',
      },
      {
        name: 'chapter1.xhtml',
        content: '<html><body><h1>Chapter 1</h1><p>Unlocked EPUB</p></body></html>',
        password: 'open me',
      },
    ]
    const lockedEpub = await makeZip(epubEntries)
    await expect(openProtectedDocument('epub', lockedEpub)).rejects.toMatchObject({ code: 'password-required' })
    await expect(openProtectedDocument('epub', lockedEpub, 'wrong')).rejects.toMatchObject({ code: 'password-incorrect' })
    expect(await openProtectedDocument('epub', lockedEpub, 'open me')).toEqual({
      kind: 'epub',
      title: 'Locked Book',
      chapters: [{ title: 'Chapter 1', paragraphs: ['Unlocked EPUB'] }],
    })

    const drmEpub = await makeZip([
      {
        name: 'META-INF/container.xml',
        content: '<container><rootfiles><rootfile full-path="book.opf"/></rootfiles></container>',
      },
      {
        name: 'META-INF/encryption.xml',
        content: '<EncryptedData xmlns="http://www.w3.org/2001/04/xmlenc#"><EncryptionMethod Algorithm="http://www.w3.org/2001/04/xmlenc#aes256-cbc"/></EncryptedData>',
      },
      {
        name: 'book.opf',
        content: '<package><manifest><item id="ch1" href="chapter1.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="ch1"/></spine></package>',
      },
      { name: 'chapter1.xhtml', content: '<html><body><p>Encrypted</p></body></html>' },
    ])
    await expect(openProtectedDocument('epub', drmEpub)).rejects.toMatchObject({ code: 'epub-drm' })
  })

  it('signs download asset URLs separately from media URLs in AssetUrlCache', async () => {
    const cache = new AssetUrlCache()
    const requests: Array<{ path?: string; download?: boolean }> = []
    const api = {
      assetCreateUrl: async (_ctx: unknown, req: { path?: string; download?: boolean }) => {
        requests.push(req)
        return { relativeUrl: `/api/assets/tok-${requests.length}`, expiresAt: Date.now() + 300_000 }
      },
    }
    const urlA = await cache.resolve({ serverId: 's1', path: '/repo/locked.zip', download: true, origin: 'http://127.0.0.1:3000', api })
    const urlB = await cache.resolve({ serverId: 's1', path: '/repo/locked.zip', origin: 'http://127.0.0.1:3000', api })
    expect(urlA).toBe('http://127.0.0.1:3000/api/assets/tok-1')
    expect(urlB).toBe('http://127.0.0.1:3000/api/assets/tok-2')
    expect(requests).toEqual([
      { path: '/repo/locked.zip', download: true },
      { path: '/repo/locked.zip' },
    ])
  })
})
