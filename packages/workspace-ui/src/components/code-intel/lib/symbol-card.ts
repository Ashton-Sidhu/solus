import type {
  CodeIntelExternalDocumentation,
  CodeIntelFreshness,
  CodeIntelLanguageStatus,
  CodeIntelLocation,
  CodeIntelReference,
  CodeIntelReferencePreview,
  CodeIntelSymbol,
  CodeIntelSymbolResult,
} from '@solus/contracts/code-intel'
import type { HostApi } from '@solus/client-core/host-api'
import type { IpcContext } from '@solus/contracts/types'

/** One click on an identifier, with everything the host needs to answer it. */
export interface CodeSymbolLookup {
  serverId: string
  api: HostApi
  ctx: IpcContext
  /** The project root the index is built for; also what locations are relative to. */
  root: string
  /** Root-relative or absolute path of the clicked file. */
  path: string
  /** 0-based. */
  line: number
  /** 0-based UTF-16 offset of the identifier's first character. */
  character: number
  token: string
  anchor: DOMRect
}

const FENCE = /^```[^\n]*\n([\s\S]*?)\n?```$/

export interface DocumentationParts {
  signature: string | null
  description: string[]
}

/** Indexers put the signature first as a fenced block; the rest is prose. */
export function splitDocumentation(documentation: string[]): DocumentationParts {
  const [first, ...rest] = documentation
  const fenced = first ? FENCE.exec(first.trim()) : null
  if (fenced) return { signature: fenced[1]!.trim(), description: rest }
  return { signature: null, description: documentation }
}

/**
 * Whether the card should describe this symbol with MDN, and from where.
 * A platform symbol the indexer already documented needs no second source —
 * TypeScript's DOM declarations carry MDN's own sentence — so the summary is
 * only fetched for the ones that would otherwise show no description at all.
 */
export function mdnReferenceFor(symbol: CodeIntelSymbol | null): CodeIntelExternalDocumentation | null {
  if (!symbol?.externalDocumentation) return null
  if (splitDocumentation(symbol.documentation).description.length > 0) return null
  return symbol.externalDocumentation
}

export interface SignatureParts {
  /** What the symbol is — `export function`, `interface`. May be empty. */
  keyword: string
  name: string
  /** Parameters, return type, members: everything after the name. */
  rest: string
}

/**
 * The card leads with the signature, weighted so the name reads first and the
 * keyword says what kind of thing it is. Indexers write the name into the
 * signature, so the split is positional; when it is absent — or when there is
 * no signature at all — the symbol's kind stands in for the keyword.
 */
export function signatureParts(signature: string | null, name: string, kind: string): SignatureParts {
  const oneLine = signature?.replace(/\s+/g, ' ').trim() ?? ''
  if (!oneLine) return { keyword: kind, name, rest: '' }
  const at = oneLine.search(new RegExp(`(?<![\\w$])${escapeForRegExp(name)}(?![\\w$])`))
  if (at === -1) return { keyword: '', name: oneLine, rest: '' }
  return {
    keyword: oneLine.slice(0, at).trim(),
    name,
    rest: oneLine.slice(at + name.length),
  }
}

function escapeForRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export interface LocationParts {
  dir: string
  name: string
  /** 1-based, as the file editor counts. */
  line: number
}

export function locationLabel(location: CodeIntelLocation): LocationParts {
  const slash = location.path.lastIndexOf('/')
  return {
    dir: slash === -1 ? '' : location.path.slice(0, slash + 1),
    name: slash === -1 ? location.path : location.path.slice(slash + 1),
    line: location.range.startLine + 1,
  }
}

/** A lexical identifier becomes interactive only when the answer can show or
 *  do something useful. This keeps the hover affordance truthful. */
export function hasUsefulSymbolAnswer(result: CodeIntelSymbolResult): boolean {
  if (!result.ok || !result.symbol) return false
  const symbol = result.symbol
  return Boolean(
    symbol.definition ||
      symbol.externalDocumentation ||
      symbol.documentation.length > 0 ||
      symbol.references.length > 0,
  )
}

/**
 * What an identifier can do. `symbol` earns the hover underline and opens the
 * card. `status` opens the card only on an explicit gesture: the index has no
 * answer yet but has something to say (a missing tool, a failed build, a root
 * with no project markers). `none` is a plain miss on a current index — and a
 * miss while a build runs, which the index toast is already narrating — so a
 * Cmd-click on a word in a string does nothing.
 */
export type CodeSymbolAvailability = 'symbol' | 'status' | 'none'

export function symbolAvailability(result: CodeIntelSymbolResult): CodeSymbolAvailability {
  if (hasUsefulSymbolAnswer(result)) return 'symbol'
  // The card is worth opening exactly when it would carry a notice. Freshness
  // is not part of that: a stale line annotates an answer and cannot stand as
  // the whole card.
  return cardNotice(result, null) ? 'status' : 'none'
}

/** Lookups carry the path as the surface knows it, root-relative or absolute;
 *  index locations are always root-relative. */
export function sameFile(a: string, b: string): boolean {
  if (a === b) return true
  return a.endsWith(`/${b}`) || b.endsWith(`/${a}`)
}

/** The user clicked the declaration itself; "Go to definition" would jump nowhere. */
export function isAtDefinition(lookup: Pick<CodeSymbolLookup, 'path' | 'line'>, location: CodeIntelLocation): boolean {
  return location.range.startLine === lookup.line && sameFile(lookup.path, location.path)
}

export interface ReferenceRow {
  path: string
  /** 1-based, as the file editor counts. */
  line: number
  preview: CodeIntelReferencePreview | null
}

export interface ReferenceGroup extends Omit<LocationParts, 'line'> {
  path: string
  /** Ascending by line, one row per line. */
  rows: ReferenceRow[]
  isCurrentFile: boolean
}

export type ReferenceListItem =
  | { kind: 'header'; key: string; group: ReferenceGroup }
  | { kind: 'reference'; key: string; row: ReferenceRow; fileName: string }
  | { kind: 'toggle'; key: string; path: string; hiddenCount: number; isExpanded: boolean }
  | { kind: 'load-more'; key: string; remaining: number; isLoading: boolean; hasError: boolean }

/** A file that uses a symbol on forty lines would push every other file out of
 *  the card. Each file shows its first few and offers the rest. */
export const REFERENCE_ROWS_PER_FILE = 5

/** References read as files, not as a repeated path per line. The file the
 *  user is looking at comes first, because its references are the ones the
 *  diff under the card already shows. */
export function groupReferences(references: CodeIntelReference[], currentPath: string): ReferenceGroup[] {
  const groups = new Map<string, ReferenceGroup>()
  for (const reference of references) {
    const label = locationLabel(reference)
    let group = groups.get(reference.path)
    if (!group) {
      group = {
        path: reference.path,
        dir: label.dir,
        name: label.name,
        rows: [],
        isCurrentFile: sameFile(currentPath, reference.path),
      }
      groups.set(reference.path, group)
    }
    if (!group.rows.some((row) => row.line === label.line)) {
      group.rows.push({ path: reference.path, line: label.line, preview: reference.preview })
    }
  }
  const ordered = [...groups.values()]
  for (const group of ordered) group.rows.sort((a, b) => a.line - b.line)
  return ordered.sort((a, b) => Number(b.isCurrentFile) - Number(a.isCurrentFile))
}

/** Flatten grouped references before rendering. A flat model gives the
 *  virtualiser stable keys and fixed-height slots while preserving file-first
 *  reading order and per-file disclosure. */
export function referenceListItems(
  groups: ReferenceGroup[],
  expandedFiles: ReadonlySet<string>,
  remaining: number,
  isLoading: boolean,
  error: string | null = null,
): ReferenceListItem[] {
  const items: ReferenceListItem[] = []
  for (const group of groups) {
    items.push({ kind: 'header', key: `header:${group.path}`, group })
    const isExpanded = expandedFiles.has(group.path)
    const rows = isExpanded ? group.rows : group.rows.slice(0, REFERENCE_ROWS_PER_FILE)
    for (const row of rows) {
      items.push({ kind: 'reference', key: `reference:${row.path}:${row.line}`, row, fileName: group.name })
    }
    if (group.rows.length > REFERENCE_ROWS_PER_FILE) {
      items.push({
        kind: 'toggle',
        key: `toggle:${group.path}`,
        path: group.path,
        hiddenCount: group.rows.length - REFERENCE_ROWS_PER_FILE,
        isExpanded,
      })
    }
  }
  if (remaining > 0) {
    items.push({ kind: 'load-more', key: 'load-more', remaining, isLoading, hasError: error !== null })
  }
  return items
}

export interface PreviewSegments {
  before: string
  match: string
  after: string
}

/** Splits a preview into the text before the symbol, the symbol, and the text
 *  after it, so the identifier can be weighted inside its own line. Offsets
 *  from an indexer that disagrees with the file collapse to plain text. */
export function previewSegments(preview: CodeIntelReferencePreview): PreviewSegments {
  const start = Math.max(0, Math.min(preview.matchStart, preview.text.length))
  const end = Math.max(start, Math.min(preview.matchEnd, preview.text.length))
  return {
    before: preview.text.slice(0, start),
    match: preview.text.slice(start, end),
    after: preview.text.slice(end),
  }
}

/** The one line above the list. It says both numbers because a symbol used
 *  ninety times in two files and one used twice in ninety files are different
 *  problems. */
export function referenceSummary(referenceCount: number, fileCount: number): string {
  const references = `${referenceCount} ${referenceCount === 1 ? 'reference' : 'references'}`
  return `${references} in ${fileCount} ${fileCount === 1 ? 'file' : 'files'}`
}

export interface CardNotice {
  tone: 'muted' | 'warning'
  text: string
  /** Shown as a copyable command, for the install hint. */
  command?: string
  action?: 'reindex' | 'retry'
}

/** The one line under the answer that says how much to trust it. Null when
 *  the index is current and nothing needs the user's attention. */
export function cardNotice(result: CodeIntelSymbolResult | null, freshness: CodeIntelFreshness | null): CardNotice | null {
  if (!result) return null
  if (!result.ok) return { tone: 'warning', text: result.error }
  const language: CodeIntelLanguageStatus | null = result.language
  if (!language) return { tone: 'muted', text: 'No indexer covers this file type.' }
  switch (language.state) {
    case 'tool-missing':
      return {
        tone: 'muted',
        text: `${language.label} navigation needs ${language.toolName} on the host.`,
        command: language.installCommand,
      }
    // A build in progress is already announced by its own toast, which lives
    // for the whole run and names the language. Repeating it in the card would
    // say the same thing twice and put a second spinner on screen.
    case 'not-indexed':
      return language.detected
        ? null
        : { tone: 'muted', text: `No ${language.label} project markers at this root.`, action: 'reindex' }
    case 'indexing':
      return null
    case 'error':
      return { tone: 'warning', text: language.error ?? `The ${language.label} index failed to build.`, action: 'retry' }
    case 'stale':
      return { tone: 'muted', text: 'Index is older than the working tree; rebuilding.', action: 'reindex' }
    case 'ready':
      if (freshness === 'stale') return { tone: 'muted', text: 'This file changed since it was indexed; positions may drift.' }
      return null
  }
}
