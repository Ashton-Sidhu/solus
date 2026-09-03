/**
 * Code intelligence: precise symbol navigation over SCIP indexes built on the
 * host. The diff pane and the file editor ask "what is at this position" and
 * get back the symbol's hover text, its definition, and its first reference
 * page in one round trip so remote clients pay one network hop per click.
 */

export const CODE_INTEL_LANGUAGES = ['typescript', 'python', 'go', 'rust'] as const
export type CodeIntelLanguage = (typeof CODE_INTEL_LANGUAGES)[number]

/** 0-based lines and UTF-16 character offsets; the end is exclusive. */
export interface CodeIntelRange {
  startLine: number
  startCharacter: number
  endLine: number
  endCharacter: number
}

export interface CodeIntelLocation {
  /** Relative to the project root the index was built for. */
  path: string
  range: CodeIntelRange
}

/** The reference's own source line, so the card reads as code rather than as a
 *  list of line numbers. Offsets are into `text`, after indentation is trimmed. */
export interface CodeIntelReferencePreview {
  text: string
  matchStart: number
  matchEnd: number
}

export interface CodeIntelReference extends CodeIntelLocation {
  /** Null when the file could not be read or the line no longer exists. */
  preview: CodeIntelReferencePreview | null
}

/**
 * Where the platform reference for a symbol lives. The card reads it in place
 * rather than handing the user to a browser, so this names the article instead
 * of carrying a link: an `article` is one page to render, and a `search` is the
 * question to ask MDN when the indexer emitted no exact page.
 */
export type CodeIntelExternalDocumentation =
  | { provider: 'mdn'; kind: 'article'; article: MdnArticlePath }
  | { provider: 'mdn'; kind: 'search'; query: string }

/** Locale-qualified MDN document path, e.g. `en-US/docs/Web/API/Document/querySelector`.
 *  No leading or trailing slash, no origin. */
export type MdnArticlePath = string

/**
 * What the card says about a platform symbol the indexer left undescribed: the
 * page's opening sentence, and the page's own name so a summary reached through
 * a search says which symbol it describes.
 */
export interface CodeIntelDocsSummary {
  title: string
  summary: string
  /** The page itself, for the reader who wants more than the opening sentence. */
  url: string
}

export interface CodeIntelDocsRequest {
  reference: CodeIntelExternalDocumentation
}

export type CodeIntelDocsResult = { ok: true; docs: CodeIntelDocsSummary } | { ok: false; error: string }

export interface CodeIntelSymbolRequest {
  cwd?: string
  /** Root-relative path of the file the position is in, using `/` separators. */
  path: string
  /** 0-based line. */
  line: number
  /** 0-based UTF-16 offset within the line. */
  character: number
}

/** Reference pages stay bounded because the host may be across a network and
 *  each location carries a source-line preview. */
export const CODE_INTEL_REFERENCE_PAGE_SIZE = 100

export interface CodeIntelReferencesRequest {
  cwd?: string
  language: CodeIntelLanguage
  /** Stable SCIP symbol returned by `codeIntelSymbolAt`. */
  symbol: string
  /** Number of raw SCIP reference occurrences already loaded. */
  offset: number
}

export type CodeIntelSymbolKind =
  | 'function'
  | 'method'
  | 'class'
  | 'interface'
  | 'struct'
  | 'enum'
  | 'trait'
  | 'type'
  | 'variable'
  | 'constant'
  | 'property'
  | 'parameter'
  | 'module'
  | 'macro'
  | 'symbol'

export interface CodeIntelSymbol {
  /** The SCIP symbol string; stable across indexes of the same project. */
  symbol: string
  name: string
  kind: CodeIntelSymbolKind
  language: CodeIntelLanguage
  /** Markdown paragraphs from the indexer, usually a fenced signature followed
   *  by the doc comment. */
  documentation: string[]
  /** Exact external reference when the symbol belongs to a platform library. */
  externalDocumentation: CodeIntelExternalDocumentation | null
  definition: CodeIntelLocation | null
  /** Capped; `referenceCount` is the full total. */
  references: CodeIntelReference[]
  referenceCount: number
  /** Distinct files across the full total, not just the ones that fit. */
  referenceFileCount: number
}

export type CodeIntelIndexState =
  /** The language's tool is not on the host PATH. */
  | 'tool-missing'
  /** Tool present, no index built for this root yet. */
  | 'not-indexed'
  | 'indexing'
  | 'ready'
  /** An answer came from an index older than the file it described. */
  | 'stale'
  | 'error'

export interface CodeIntelLanguageStatus {
  language: CodeIntelLanguage
  label: string
  /** The language's marker files exist in this root. */
  detected: boolean
  toolName: string
  toolInstalled: boolean
  installCommand: string
  state: CodeIntelIndexState
  indexedAt: number | null
  documentCount: number
  error: string | null
}

export interface CodeIntelStatus {
  /** Null when the request named no project; only tool availability is known then. */
  root: string | null
  languages: CodeIntelLanguageStatus[]
}

export interface CodeIntelStatusRequest {
  cwd?: string
}

export interface CodeIntelReindexRequest {
  cwd?: string
  /** Omit to rebuild every detected language. */
  language?: CodeIntelLanguage
}

export interface CodeIntelInstallRequest {
  language: CodeIntelLanguage
}

/** Whether the file the answer describes still matches the index. */
export type CodeIntelFreshness = 'fresh' | 'stale'

export type CodeIntelSymbolResult =
  | {
      ok: true
      /** Null when nothing is indexed at that position. */
      symbol: CodeIntelSymbol | null
      /** Null when the file's extension maps to no supported language. */
      language: CodeIntelLanguageStatus | null
      freshness: CodeIntelFreshness
    }
  | { ok: false; error: string }

export type CodeIntelReferencesResult =
  | {
      ok: true
      references: CodeIntelReference[]
      referenceCount: number
      /** Null when this page reaches the full result. */
      nextOffset: number | null
    }
  | { ok: false; error: string }

export type CodeIntelReindexResult =
  | { ok: true; status: CodeIntelStatus }
  | { ok: false; error: string }

export type CodeIntelInstallResult =
  | { ok: true; status: CodeIntelStatus }
  | { ok: false; error: string }
