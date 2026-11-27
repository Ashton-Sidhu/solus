import { SaxesParser } from 'saxes'
import { isCompoundOfficeFile } from './office-encrypted-streams'
import { decryptOffice } from './office-encryption'
import { unlockOpenDocument } from './opendocument-encryption'
import {
  ProtectedPreviewError,
  type ProtectedPreviewKind,
} from './protected-preview-error'
import { readBoundedZip, type ZipArchiveEntry } from './zip-archive'

export type DocumentBlock =
  | { kind: 'heading'; level: number; text: string }
  | { kind: 'paragraph'; text: string }
  | { kind: 'table'; rows: string[][] }

export interface SpreadsheetSheet {
  name: string
  rows: string[][]
  truncated: boolean
}

export interface PresentationSlide {
  index: number
  lines: string[]
}

export interface EpubChapter {
  title: string
  paragraphs: string[]
}

export type DecodedDocumentPreview =
  | { kind: 'document'; blocks: DocumentBlock[] }
  | { kind: 'spreadsheet'; sheets: SpreadsheetSheet[] }
  | { kind: 'presentation'; slides: PresentationSlide[] }
  | { kind: 'epub'; title: string; chapters: EpubChapter[] }

interface XmlElementNode {
  kind: 'element'
  name: string
  local: string
  uri: string
  attrs: Map<string, string>
  children: XmlChild[]
}

interface XmlTextNode {
  kind: 'text'
  value: string
}

type XmlChild = XmlElementNode | XmlTextNode

const MAX_XML_NODES = 150_000
const MAX_SHEET_ROWS = 500
const MAX_SHEET_COLS = 100
const MAX_EPUB_CHAPTERS = 200
const IDPF_OBFUSCATION = 'http://www.idpf.org/2008/embedding'
const ADOBE_OBFUSCATION = 'http://ns.adobe.com/pdf/enc#RC'
const XMLENC_NS = 'http://www.w3.org/2001/04/xmlenc#'

function decodeXmlBytes(bytes: Uint8Array): string {
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    return new TextDecoder('utf-16le').decode(bytes)
  }
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    return new TextDecoder('utf-16be').decode(bytes)
  }
  return new TextDecoder('utf-8').decode(bytes)
}

function parseXml(source: string): XmlElementNode {
  const root: XmlElementNode = { kind: 'element', name: '', local: '', uri: '', attrs: new Map(), children: [] }
  const stack: XmlElementNode[] = [root]
  let count = 0
  const parser = new SaxesParser({ xmlns: true })
  parser.on('doctype', () => {
    throw new ProtectedPreviewError('document-invalid')
  })
  parser.on('error', () => {
    throw new ProtectedPreviewError('document-invalid')
  })
  parser.on('opentag', (tag) => {
    if (++count > MAX_XML_NODES) throw new ProtectedPreviewError('archive-expanded-too-large')
    const attrs = new Map<string, string>()
    for (const [key, attr] of Object.entries(tag.attributes)) {
      attrs.set(key, attr.value)
      attrs.set(attr.local, attr.value)
      if (attr.uri) attrs.set(`{${attr.uri}}${attr.local}`, attr.value)
    }
    const node: XmlElementNode = {
      kind: 'element',
      name: tag.name,
      local: tag.local,
      uri: tag.uri,
      attrs,
      children: [],
    }
    stack.at(-1)?.children.push(node)
    stack.push(node)
  })
  parser.on('text', (value) => {
    if (value) stack.at(-1)?.children.push({ kind: 'text', value })
  })
  parser.on('cdata', (value) => {
    if (value) stack.at(-1)?.children.push({ kind: 'text', value })
  })
  parser.on('closetag', () => {
    if (stack.length > 1) stack.pop()
  })
  parser.write(source).close()
  const first = root.children.find((child): child is XmlElementNode => child.kind === 'element')
  if (!first) throw new ProtectedPreviewError('document-invalid')
  return first
}

function childElements(node: XmlElementNode): XmlElementNode[] {
  return node.children.filter((child): child is XmlElementNode => child.kind === 'element')
}

function findByLocal(node: XmlElementNode, local: string, uri?: string): XmlElementNode[] {
  const matches: XmlElementNode[] = []
  const visit = (current: XmlElementNode) => {
    for (const child of current.children) {
      if (child.kind !== 'element') continue
      if (child.local === local && (uri === undefined || child.uri === uri)) matches.push(child)
      visit(child)
    }
  }
  visit(node)
  return matches
}

function textContent(node: XmlElementNode): string {
  const parts: string[] = []
  const visit = (current: XmlElementNode) => {
    for (const child of current.children) {
      if (child.kind === 'text') parts.push(child.value)
      else if (child.local === 'br' || child.local === 'line-break') parts.push('\n')
      else if (child.local === 'tab') parts.push('\t')
      else visit(child)
    }
  }
  visit(node)
  return parts.join('')
}

function readXmlEntry(files: Map<string, ZipArchiveEntry>, entryName: string): XmlElementNode | null {
  const entry = files.get(entryName)
  if (!entry?.bytes.length) return null
  return parseXml(decodeXmlBytes(entry.bytes))
}

function parseDocx(files: Map<string, ZipArchiveEntry>): DecodedDocumentPreview {
  const doc = readXmlEntry(files, 'word/document.xml')
  if (!doc) throw new ProtectedPreviewError('document-invalid')
  const body = findByLocal(doc, 'body')[0] ?? doc
  const blocks: DocumentBlock[] = []
  for (const child of childElements(body)) {
    if (child.local === 'p') {
      const text = textContent(child).trim()
      if (!text) continue
      const style = findByLocal(child, 'pStyle')[0]?.attrs.get('val') ?? ''
      const heading = /^Heading([1-6])$/i.exec(style)
      if (heading) blocks.push({ kind: 'heading', level: Number(heading[1]), text })
      else blocks.push({ kind: 'paragraph', text })
    } else if (child.local === 'tbl') {
      const rows = findByLocal(child, 'tr').map((row) =>
        childElements(row)
          .filter((cell) => cell.local === 'tc')
          .map((cell) => textContent(cell).trim()),
      )
      if (rows.length) blocks.push({ kind: 'table', rows })
    }
  }
  return { kind: 'document', blocks }
}

function columnIndexFromRef(ref: string): number {
  const letters = /^[A-Z]+/i.exec(ref)?.[0]?.toUpperCase()
  if (!letters) return -1
  let index = 0
  for (let i = 0; i < letters.length; i++) {
    index = index * 26 + (letters.charCodeAt(i) - 64)
  }
  return index - 1
}

function readWorkbookRelTargets(files: Map<string, ZipArchiveEntry>): Map<string, string> {
  const relTargets = new Map<string, string>()
  const rels = readXmlEntry(files, 'xl/_rels/workbook.xml.rels')
  if (!rels) return relTargets
  for (const rel of findByLocal(rels, 'Relationship')) {
    const id = rel.attrs.get('Id')
    const target = rel.attrs.get('Target')
    if (id && target) {
      const normalized = target.startsWith('/') ? target.slice(1) : `xl/${target.replace(/^\.\//, '')}`
      relTargets.set(id, normalized)
    }
  }
  return relTargets
}

function parseXlsxRow(rowNode: XmlElementNode, sharedStrings: string[]): string[] {
  const cells: string[] = []
  for (const cell of childElements(rowNode)) {
    if (cell.local !== 'c') continue
    const col = columnIndexFromRef(cell.attrs.get('r') ?? '')
    const index = col >= 0 ? col : cells.length
    if (index >= MAX_SHEET_COLS) continue
    while (cells.length < index) cells.push('')
    const type = cell.attrs.get('t') ?? ''
    if (type === 's') {
      const idx = Number(textContent(findByLocal(cell, 'v')[0] ?? cell))
      cells[index] = Number.isInteger(idx) ? (sharedStrings[idx] ?? '') : ''
    } else if (type === 'inlineStr') {
      cells[index] = textContent(cell)
    } else {
      cells[index] = textContent(findByLocal(cell, 'v')[0] ?? cell)
    }
  }
  return cells
}

function parseXlsx(files: Map<string, ZipArchiveEntry>): DecodedDocumentPreview {
  const workbook = readXmlEntry(files, 'xl/workbook.xml')
  if (!workbook) throw new ProtectedPreviewError('document-invalid')
  const relTargets = readWorkbookRelTargets(files)
  const sst = readXmlEntry(files, 'xl/sharedStrings.xml')
  const sharedStrings = sst ? findByLocal(sst, 'si').map(textContent) : []
  const sheetNodes = findByLocal(workbook, 'sheet').slice(0, 50)
  const sheets: SpreadsheetSheet[] = []
  for (let i = 0; i < sheetNodes.length; i++) {
    const node = sheetNodes[i]!
    const name = node.attrs.get('name') || `Sheet ${i + 1}`
    const relId = node.attrs.get('id')
    const targetEntry = (relId && relTargets.get(relId)) || `xl/worksheets/sheet${i + 1}.xml`
    const sheetXml = readXmlEntry(files, targetEntry)
    if (!sheetXml) continue
    const rowNodes = findByLocal(sheetXml, 'row')
    const rows = rowNodes
      .slice(0, MAX_SHEET_ROWS)
      .map((rowNode) => parseXlsxRow(rowNode, sharedStrings))
      .filter((cells) => cells.length > 0)
    sheets.push({ name, rows, truncated: rowNodes.length > MAX_SHEET_ROWS })
  }
  if (!sheets.length) throw new ProtectedPreviewError('document-invalid')
  return { kind: 'spreadsheet', sheets }
}

function parsePptx(files: Map<string, ZipArchiveEntry>): DecodedDocumentPreview {
  const slideEntries = [...files.keys()]
    .filter((entry) => /^ppt\/slides\/slide\d+\.xml$/i.test(entry))
    .sort((a, b) => {
      const left = Number(/slide(\d+)\.xml$/i.exec(a)?.[1] ?? 0)
      const right = Number(/slide(\d+)\.xml$/i.exec(b)?.[1] ?? 0)
      return left - right
    })
    .slice(0, 200)
  if (!slideEntries.length) throw new ProtectedPreviewError('document-invalid')
  const slides: PresentationSlide[] = slideEntries.map((entry, idx) => {
    const xml = readXmlEntry(files, entry)
    const lines = xml
      ? findByLocal(xml, 'p')
          .map((paragraph) => textContent(paragraph).trim())
          .filter(Boolean)
      : []
    return { index: idx + 1, lines }
  })
  return { kind: 'presentation', slides }
}

function parseOdsTable(table: XmlElementNode, idx: number): SpreadsheetSheet {
  const name = table.attrs.get('name') || `Sheet ${idx + 1}`
  const rows: string[][] = []
  let truncated = false
  for (const rowNode of childElements(table)) {
    if (rowNode.local !== 'table-row') continue
    const repeatRows = Math.min(Number(rowNode.attrs.get('number-rows-repeated') ?? 1) || 1, 50)
    const cells: string[] = []
    for (const cellNode of childElements(rowNode)) {
      if (cellNode.local !== 'table-cell' && cellNode.local !== 'covered-table-cell') continue
      const repeatCols = Math.min(
        Number(cellNode.attrs.get('number-columns-repeated') ?? 1) || 1,
        MAX_SHEET_COLS - cells.length,
      )
      const value = textContent(cellNode).trim()
      for (let r = 0; r < repeatCols && cells.length < MAX_SHEET_COLS; r++) cells.push(value)
    }
    if (!cells.some(Boolean)) continue
    for (let r = 0; r < repeatRows; r++) {
      if (rows.length >= MAX_SHEET_ROWS) {
        truncated = true
        break
      }
      rows.push(cells)
    }
    if (truncated) break
  }
  return { name, rows, truncated }
}

function parseOpenDocument(
  files: Map<string, ZipArchiveEntry>,
  kind: 'odt' | 'ods' | 'odp',
): DecodedDocumentPreview {
  const root = readXmlEntry(files, 'content.xml')
  if (!root) throw new ProtectedPreviewError('document-invalid')
  if (kind === 'ods') {
    const tables = findByLocal(root, 'table').slice(0, 50)
    if (!tables.length) throw new ProtectedPreviewError('document-invalid')
    return { kind: 'spreadsheet', sheets: tables.map(parseOdsTable) }
  }
  if (kind === 'odp') {
    const pages = findByLocal(root, 'page').slice(0, 200)
    const slides: PresentationSlide[] = pages.map((page, idx) => ({
      index: idx + 1,
      lines: findByLocal(page, 'p')
        .map((paragraph) => textContent(paragraph).trim())
        .filter(Boolean),
    }))
    return { kind: 'presentation', slides }
  }
  const textBody = findByLocal(root, 'text')[0] ?? root
  const blocks: DocumentBlock[] = []
  for (const child of childElements(textBody)) {
    if (child.local === 'h') {
      const text = textContent(child).trim()
      if (text) {
        const level = Math.min(6, Math.max(1, Number(child.attrs.get('outline-level') ?? 1) || 1))
        blocks.push({ kind: 'heading', level, text })
      }
    } else if (child.local === 'p') {
      const text = textContent(child).trim()
      if (text) blocks.push({ kind: 'paragraph', text })
    } else if (child.local === 'list') {
      for (const item of findByLocal(child, 'p')) {
        const text = textContent(item).trim()
        if (text) blocks.push({ kind: 'paragraph', text: `• ${text}` })
      }
    } else if (child.local === 'table') {
      const rows = findByLocal(child, 'table-row').map((row) =>
        childElements(row)
          .filter((cell) => cell.local === 'table-cell')
          .map((cell) => textContent(cell).trim()),
      )
      if (rows.length) blocks.push({ kind: 'table', rows })
    }
  }
  return { kind: 'document', blocks }
}

function resolveZipRelativeName(baseDir: string, href: string): string {
  const cleanHref = decodeURIComponent(href.split('#', 1)[0] ?? '')
  const parts = (baseDir ? `${baseDir}/${cleanHref}` : cleanHref).split('/')
  const resolved: string[] = []
  for (const part of parts) {
    if (part === '..') resolved.pop()
    else if (part && part !== '.') resolved.push(part)
  }
  return resolved.join('/')
}

function checkEpubDrm(files: Map<string, ZipArchiveEntry>): void {
  if (files.has('META-INF/license.lcpl')) throw new ProtectedPreviewError('epub-drm')
  const encryptionEntry = files.get('META-INF/encryption.xml')
  if (!encryptionEntry?.bytes.length) return
  try {
    const encryption = parseXml(decodeXmlBytes(encryptionEntry.bytes))
    const encryptedNodes = [
      ...(encryption.local === 'EncryptedData' && encryption.uri === XMLENC_NS ? [encryption] : []),
      ...findByLocal(encryption, 'EncryptedData', XMLENC_NS),
    ]
    for (const node of encryptedNodes) {
      const algorithm = findByLocal(node, 'EncryptionMethod', XMLENC_NS)[0]?.attrs.get('Algorithm')
      if (!algorithm) continue
      if (algorithm !== IDPF_OBFUSCATION && algorithm !== ADOBE_OBFUSCATION) {
        throw new ProtectedPreviewError('epub-drm')
      }
    }
  } catch (cause) {
    if (cause instanceof ProtectedPreviewError && cause.code === 'epub-drm') throw cause
  }
}

function parseEpubChapter(bytes: Uint8Array, fallbackIndex: number): EpubChapter | null {
  try {
    const doc = parseXml(decodeXmlBytes(bytes))
    const heading = findByLocal(doc, 'h1')[0] ?? findByLocal(doc, 'h2')[0] ?? findByLocal(doc, 'title')[0]
    const title = (heading ? textContent(heading).trim() : '') || `Section ${fallbackIndex}`
    const body = findByLocal(doc, 'body')[0] ?? doc
    const blockNodes = findByLocal(body, 'p')
    const paragraphs = (
      blockNodes.length ? blockNodes.map((p) => textContent(p).trim()) : [textContent(body).trim()]
    ).filter(Boolean)
    return { title, paragraphs }
  } catch {
    const fallback = decodeXmlBytes(bytes).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
    return fallback ? { title: `Section ${fallbackIndex}`, paragraphs: [fallback] } : null
  }
}

export function parseEpub(files: Map<string, ZipArchiveEntry>): DecodedDocumentPreview {
  checkEpubDrm(files)
  const container = readXmlEntry(files, 'META-INF/container.xml')
  const opfEntry = container ? findByLocal(container, 'rootfile')[0]?.attrs.get('full-path') : undefined
  const opf = opfEntry ? readXmlEntry(files, opfEntry) : null
  if (!opfEntry || !opf) throw new ProtectedPreviewError('document-invalid')
  const segments = opfEntry.split('/')
  const baseDir = segments.length > 1 ? segments.slice(0, -1).join('/') : ''
  const titleNode = findByLocal(opf, 'title')[0]
  const bookTitle = (titleNode ? textContent(titleNode).trim() : '') || 'EPUB'
  const manifest = new Map<string, string>()
  for (const item of findByLocal(opf, 'item')) {
    const id = item.attrs.get('id')
    const href = item.attrs.get('href')
    if (id && href) manifest.set(id, resolveZipRelativeName(baseDir, href))
  }
  const chapters: EpubChapter[] = []
  for (const itemref of findByLocal(opf, 'itemref').slice(0, MAX_EPUB_CHAPTERS)) {
    const idref = itemref.attrs.get('idref')
    const entryName = idref ? manifest.get(idref) : undefined
    const entry = entryName ? files.get(entryName) : undefined
    if (!entry?.bytes.length) continue
    const chapter = parseEpubChapter(entry.bytes, chapters.length + 1)
    if (chapter) chapters.push(chapter)
  }
  if (!chapters.length) throw new ProtectedPreviewError('document-invalid')
  return { kind: 'epub', title: bookTitle, chapters }
}

export async function openProtectedDocument(
  kind: Exclude<ProtectedPreviewKind, 'zip'>,
  bytes: ArrayBuffer,
  password?: string,
  signal?: AbortSignal,
): Promise<DecodedDocumentPreview> {
  let zipBytes = bytes
  if ((kind === 'docx' || kind === 'xlsx' || kind === 'pptx') && isCompoundOfficeFile(bytes)) {
    zipBytes = decryptOffice(bytes, password)
  }
  const files = await readBoundedZip(zipBytes, {
    password,
    maxEntries: kind === 'epub' ? 8192 : 2048,
    signal,
  })
  if (kind === 'odt' || kind === 'ods' || kind === 'odp') {
    await unlockOpenDocument(files, password)
    return parseOpenDocument(files, kind)
  }
  if (kind === 'epub') return parseEpub(files)
  if (kind === 'docx') return parseDocx(files)
  if (kind === 'xlsx') return parseXlsx(files)
  return parsePptx(files)
}
