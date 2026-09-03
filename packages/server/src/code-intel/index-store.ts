import type {
  CodeIntelLanguage,
  CodeIntelLocation,
  CodeIntelSymbol,
  CodeIntelSymbolKind,
} from '@solus/contracts/code-intel'
import { CODE_INTEL_REFERENCE_PAGE_SIZE } from '@solus/contracts/code-intel'
import {
  SCIP_ROLE_DEFINITION,
  type ScipIndex,
  type ScipOccurrence,
  type ScipSymbolInformation,
} from './scip-decoder'
import { isLocalSymbol, symbolDisplayName } from './symbol-name'
import { mdnDocumentationFor } from './mdn-documentation'

export interface CodeIntelReferencePage {
  references: CodeIntelLocation[]
  referenceCount: number
  nextOffset: number | null
}

interface DocumentEntry {
  /** Sorted by start position so a lookup can stop early. */
  occurrences: ScipOccurrence[]
}

/** SCIP `SymbolInformation.Kind` values, mapped to the kinds the card shows. */
const SCIP_KINDS: ReadonlyMap<number, CodeIntelSymbolKind> = new Map([
  [7, 'class'],
  [8, 'constant'],
  [9, 'method'],
  [11, 'enum'],
  [12, 'constant'],
  [15, 'property'],
  [16, 'module'],
  [17, 'function'],
  [18, 'method'],
  [21, 'interface'],
  [25, 'macro'],
  [26, 'method'],
  [29, 'module'],
  [30, 'module'],
  [35, 'module'],
  [37, 'parameter'],
  [41, 'property'],
  [44, 'parameter'],
  [45, 'method'],
  [49, 'struct'],
  [53, 'trait'],
  [54, 'type'],
  [55, 'type'],
  [58, 'type'],
  [61, 'variable'],
  [66, 'method'],
  [70, 'method'],
  [80, 'method'],
])

/** Producers often leave `kind` unset; the descriptor suffix still tells the shape. */
function kindFromDescriptor(symbol: string): CodeIntelSymbolKind {
  if (isLocalSymbol(symbol)) return 'variable'
  if (symbol.endsWith('().')) {
    const owner = symbol.slice(0, -3)
    return owner.lastIndexOf('#') > owner.lastIndexOf('/') ? 'method' : 'function'
  }
  if (symbol.endsWith(')')) return 'parameter'
  if (symbol.endsWith(']')) return 'type'
  if (symbol.endsWith('#')) return 'class'
  if (symbol.endsWith('/')) return 'module'
  if (symbol.endsWith('!')) return 'macro'
  if (symbol.endsWith('.')) {
    const owner = symbol.slice(0, -1)
    return owner.lastIndexOf('#') > owner.lastIndexOf('/') ? 'property' : 'variable'
  }
  return 'symbol'
}

/**
 * SCIP `local N` ids are numbered per document, so the same id names a
 * different binding in every file. Keyed on the id alone, every local in the
 * project collapses into a handful of buckets: in this repo's own index, 68,079
 * local occurrences fall into 1,540 ids, and `local 2` claims 1,584 references
 * across 554 unrelated files. Qualifying the key with the document keeps a
 * local's answer inside the file it lives in. The result is opaque to callers,
 * which pass it back verbatim to ask for a later reference page.
 */
function symbolKey(path: string, symbol: string): string {
  return isLocalSymbol(symbol) ? `${path} ${symbol}` : symbol
}

function compareStart(a: ScipOccurrence, b: ScipOccurrence): number {
  return a.range.startLine - b.range.startLine || a.range.startCharacter - b.range.startCharacter
}

function contains(occurrence: ScipOccurrence, line: number, character: number): boolean {
  const { startLine, startCharacter, endLine, endCharacter } = occurrence.range
  if (line < startLine || line > endLine) return false
  if (line === startLine && character < startCharacter) return false
  if (line === endLine && character >= endCharacter) return false
  return true
}

function span(occurrence: ScipOccurrence): number {
  const { startLine, startCharacter, endLine, endCharacter } = occurrence.range
  return (endLine - startLine) * 10_000 + (endCharacter - startCharacter)
}

/** Indexers disagree on whether `relative_path` is relative; make it so. */
function normalizeDocumentPath(relativePath: string, projectRoot: string): string {
  let path = relativePath.replaceAll('\\', '/')
  const root = projectRoot.startsWith('file://') ? decodeURIComponent(projectRoot.slice('file://'.length)) : projectRoot
  if (root && path.startsWith(root)) path = path.slice(root.length)
  return path.replace(/^\/+/, '')
}

/**
 * One decoded language index, shaped into position → symbol and symbol →
 * locations maps for fast queries.
 */
export class CodeIntelIndex {
  private readonly language: CodeIntelLanguage
  private readonly documents = new Map<string, DocumentEntry>()
  private readonly symbols = new Map<string, ScipSymbolInformation>()
  private readonly definitions = new Map<string, CodeIntelLocation>()
  private readonly references = new Map<string, CodeIntelLocation[]>()

  static fromScip(language: CodeIntelLanguage, index: ScipIndex): CodeIntelIndex {
    const store = new CodeIntelIndex(language)
    store.addIndex(index)
    return store
  }

  private constructor(language: CodeIntelLanguage) {
    this.language = language
  }

  private addIndex(index: ScipIndex): void {
    for (const info of index.externalSymbols) this.rememberSymbol(info, null)
    for (const document of index.documents) {
      const path = normalizeDocumentPath(document.relativePath, index.projectRoot)
      if (!path) continue
      for (const info of document.symbols) this.rememberSymbol(info, path)
      const occurrences = document.occurrences.slice().sort(compareStart)
      for (const occurrence of occurrences) {
        const key = symbolKey(path, occurrence.symbol)
        const location: CodeIntelLocation = { path, range: occurrence.range }
        if ((occurrence.symbolRoles & SCIP_ROLE_DEFINITION) !== 0) {
          if (!this.definitions.has(key)) this.definitions.set(key, location)
          continue
        }
        const list = this.references.get(key)
        if (list) list.push(location)
        else this.references.set(key, [location])
      }
      this.documents.set(path, { occurrences })
    }
  }

  /** `path` is the document the record came from, or null for an external
   *  symbol, which is never local. */
  private rememberSymbol(info: ScipSymbolInformation, path: string | null): void {
    if (!info.symbol) return
    const key = path === null ? info.symbol : symbolKey(path, info.symbol)
    const existing = this.symbols.get(key)
    // A document that references a symbol may carry a thinner record than the
    // one that defines it; keep whichever has documentation.
    if (!existing || (existing.documentation.length === 0 && info.documentation.length > 0)) {
      this.symbols.set(key, info)
    }
  }

  hasDocument(path: string): boolean {
    return this.documents.has(path)
  }

  documentPaths(): Iterable<string> {
    return this.documents.keys()
  }

  get documentCount(): number {
    return this.documents.size
  }

  /** The narrowest occurrence covering the position, or null. */
  occurrenceAt(path: string, line: number, character: number): ScipOccurrence | null {
    const document = this.documents.get(path)
    if (!document) return null
    let best: ScipOccurrence | null = null
    for (const occurrence of document.occurrences) {
      if (occurrence.range.startLine > line) break
      if (!contains(occurrence, line, character)) continue
      if (!best || span(occurrence) < span(best)) best = occurrence
    }
    return best
  }

  symbolAt(path: string, line: number, character: number): CodeIntelSymbol | null {
    const document = this.documents.get(path)
    const occurrence = this.occurrenceAt(path, line, character)
    if (!document || !occurrence) return null
    // Naming and classification read the SCIP id itself; storage reads the key.
    const key = symbolKey(path, occurrence.symbol)
    const info = this.symbols.get(key)
    const references = this.references.get(key) ?? []
    const kind = (info && SCIP_KINDS.get(info.kind)) ?? kindFromDescriptor(occurrence.symbol)
    const name = info?.displayName || symbolDisplayName(occurrence.symbol) || occurrence.symbol
    const documentation = info ? info.documentation.slice() : []
    if (info?.signature && documentation.length === 0) documentation.push(info.signature)
    const externalDocumentation = mdnDocumentationFor(occurrence.symbol, name, documentation)
    return {
      symbol: key,
      name,
      kind,
      language: this.language,
      documentation,
      externalDocumentation,
      definition: this.definitions.get(key) ?? null,
      // Previews are read from disk by the manager, which knows the root.
      references: references.slice(0, CODE_INTEL_REFERENCE_PAGE_SIZE).map((location) => ({ ...location, preview: null })),
      referenceCount: references.length,
      referenceFileCount: new Set(references.map((location) => location.path)).size,
    }
  }

  /** A bounded slice for a card that asked to continue beyond its first page. */
  referencesFor(symbol: string, offset: number): CodeIntelReferencePage {
    const all = this.references.get(symbol) ?? []
    const start = Number.isSafeInteger(offset) && offset >= 0 ? offset : 0
    const end = Math.min(start + CODE_INTEL_REFERENCE_PAGE_SIZE, all.length)
    return {
      references: all.slice(start, end),
      referenceCount: all.length,
      nextOffset: end < all.length ? end : null,
    }
  }
}
