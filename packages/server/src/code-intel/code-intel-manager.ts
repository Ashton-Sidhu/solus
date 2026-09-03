import { spawn } from 'child_process'
import { createHash, randomUUID } from 'crypto'
import { mkdir, readFile, realpath, rm, writeFile } from 'fs/promises'
import { join } from 'path'
import type {
  CodeIntelIndexState,
  CodeIntelInstallRequest,
  CodeIntelLanguage,
  CodeIntelLanguageStatus,
  CodeIntelReferencesRequest,
  CodeIntelReferencesResult,
  CodeIntelReindexRequest,
  CodeIntelStatus,
  CodeIntelSymbol,
  CodeIntelSymbolRequest,
  CodeIntelSymbolResult,
} from '@solus/contracts/code-intel'
import { getCliEnv } from '../cli-env'
import { createLogger } from '../logger'
import { solusDir } from '../platform/paths'
import { CODE_INTEL_ADAPTERS, detectLanguage, languageForPath, resolveToolBinary, type CodeIntelAdapter } from './adapters'
import { CodeIntelIndex } from './index-store'
import { withReferencePreviews } from './reference-previews'
import { decodeScipIndex } from './scip-decoder'
import { installCodeIntelTool } from './tool-installer'

const log = createLogger('code-intel', 'code-intel-manager.ts')

/** scip-java needs a build; the four we ship do not, but a large monorepo can
 *  still take minutes. Past this the run is a hang, not a slow index. */
const INDEX_TIMEOUT_MS = 15 * 60_000
/** A branch switch touches many files at once; one rebuild covers them all. */
const STALE_REINDEX_DEBOUNCE_MS = 2_000
/** A file the indexer skips (generated, excluded) reads stale on every click;
 *  without this floor that click would rebuild the index forever. */
const AUTO_REINDEX_MIN_INTERVAL_MS = 60_000
const STDERR_TAIL_BYTES = 4_000
const HASH_CONCURRENCY = 32

interface IndexMeta {
  indexedAt: number
  files: { path: string; hash: string }[]
}

interface IndexRun {
  abort: AbortController
}

interface LanguageState {
  adapter: CodeIntelAdapter
  detected: boolean
  state: CodeIntelIndexState
  indexedAt: number | null
  error: string | null
  store: CodeIntelIndex | null
  /** Content hash per indexed document at index time; the staleness oracle. */
  fileHashes: Map<string, string>
  run: IndexRun | null
  lastAutoReindexAt: number
  reindexTimer: ReturnType<typeof setTimeout> | null
}

interface RootState {
  root: string
  cacheDir: string
  languages: Map<CodeIntelLanguage, LanguageState>
  loading: Promise<void> | null
}

type StatusListener = (status: CodeIntelStatus) => void

interface SymbolLogFacts {
  found: boolean
  symbolName: string | null
  referenceCount: number
  returnedReferenceCount: number
  referenceFileCount: number
}

function symbolLogFacts(symbol: CodeIntelSymbol | null): SymbolLogFacts {
  if (!symbol) {
    return {
      found: false,
      symbolName: null,
      referenceCount: 0,
      returnedReferenceCount: 0,
      referenceFileCount: 0,
    }
  }
  return {
    found: true,
    symbolName: symbol.name,
    referenceCount: symbol.referenceCount,
    returnedReferenceCount: symbol.references.length,
    referenceFileCount: symbol.referenceFileCount,
  }
}

function hashContents(contents: Uint8Array): string {
  return createHash('sha1').update(contents).digest('hex')
}

function cacheDirFor(root: string): string {
  return join(solusDir(), 'code-intel', createHash('sha256').update(root).digest('hex').slice(0, 16))
}

/**
 * Builds and serves SCIP indexes per project root. Indexes live on disk under
 * the Solus data dir and in memory once a root is first asked about. A query
 * on a file whose contents no longer match the index answers anyway, marks
 * the answer stale, and rebuilds in the background.
 */
export class CodeIntelManager {
  private readonly roots = new Map<string, RootState>()
  private readonly listeners = new Set<StatusListener>()
  private readonly installRuns = new Map<CodeIntelLanguage, Promise<CodeIntelStatus>>()

  onStatusChanged(listener: StatusListener): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  async status(root: string | null): Promise<CodeIntelStatus> {
    if (!root) {
      return {
        root: null,
        languages: CODE_INTEL_ADAPTERS.map((adapter) => this.hostOnlyStatus(adapter)),
      }
    }
    const rootState = await this.rootState(root)
    return this.snapshot(rootState)
  }

  async symbolAt(root: string, request: CodeIntelSymbolRequest, requestId = randomUUID()): Promise<CodeIntelSymbolResult> {
    const startedAt = Date.now()
    log.info('code_intel_symbol_lookup_started', {
      requestId,
      root,
      path: request.path,
      line: request.line,
      character: request.character,
    })
    const rootStartedAt = Date.now()
    const rootState = await this.rootState(root)
    log.info('code_intel_symbol_root_ready', {
      requestId,
      root: rootState.root,
      durationMs: Date.now() - rootStartedAt,
    })
    const path = request.path
    const language = languageForPath(path)
    if (!language) {
      log.info('code_intel_symbol_lookup_finished', {
        requestId,
        result: 'unsupported-language',
        durationMs: Date.now() - startedAt,
      })
      return { ok: true, symbol: null, language: null, freshness: 'fresh' }
    }
    const languageState = rootState.languages.get(language)!
    log.info('code_intel_symbol_language_ready', {
      requestId,
      language,
      detected: languageState.detected,
      state: languageState.state,
      hasStore: languageState.store !== null,
    })
    if (!languageState.detected) {
      log.info('code_intel_symbol_lookup_finished', {
        requestId,
        result: 'language-not-detected',
        durationMs: Date.now() - startedAt,
      })
      return { ok: true, symbol: null, language: this.languageStatus(languageState), freshness: 'fresh' }
    }
    if (!languageState.store) {
      // First use of a root is the moment to build: the user has asked a
      // question only an index can answer, and the tool is present.
      if (languageState.state === 'not-indexed' && resolveToolBinary(languageState.adapter, rootState.root)) {
        this.startIndex(rootState, languageState, 'first-query')
      }
      log.info('code_intel_symbol_lookup_finished', {
        requestId,
        result: 'index-not-ready',
        state: languageState.state,
        durationMs: Date.now() - startedAt,
      })
      return { ok: true, symbol: null, language: this.languageStatus(languageState), freshness: 'fresh' }
    }
    const indexStartedAt = Date.now()
    const symbol = languageState.store.symbolAt(path, request.line, request.character)
    const symbolFacts = symbolLogFacts(symbol)
    log.info('code_intel_symbol_index_lookup_finished', {
      requestId,
      ...symbolFacts,
      durationMs: Date.now() - indexStartedAt,
    })
    if (symbol && symbol.references.length > 0) {
      symbol.references = await withReferencePreviews(rootState.root, symbol.references, {
        requestId,
        operation: 'symbol',
      })
    }
    const freshnessStartedAt = Date.now()
    const freshness = await this.freshnessOf(rootState, languageState, path)
    log.info('code_intel_symbol_freshness_finished', {
      requestId,
      freshness,
      durationMs: Date.now() - freshnessStartedAt,
    })
    if (freshness === 'stale') this.scheduleAutoReindex(rootState, languageState)
    log.info('code_intel_symbol_lookup_finished', {
      requestId,
      result: symbolFacts.found ? 'symbol' : 'no-symbol',
      ...symbolFacts,
      freshness,
      durationMs: Date.now() - startedAt,
    })
    return { ok: true, symbol, language: this.languageStatus(languageState), freshness }
  }

  async references(root: string, request: CodeIntelReferencesRequest, requestId = randomUUID()): Promise<CodeIntelReferencesResult> {
    const startedAt = Date.now()
    log.info('code_intel_reference_page_started', {
      requestId,
      root,
      language: request.language,
      offset: request.offset,
    })
    const rootStartedAt = Date.now()
    const rootState = await this.rootState(root)
    log.info('code_intel_reference_page_root_ready', {
      requestId,
      root: rootState.root,
      durationMs: Date.now() - rootStartedAt,
    })
    const languageState = rootState.languages.get(request.language)
    if (!languageState?.store) {
      log.info('code_intel_reference_page_finished', {
        requestId,
        result: 'index-not-ready',
        durationMs: Date.now() - startedAt,
      })
      return { ok: false, error: 'The code-intelligence index is not ready.' }
    }
    if (!Number.isSafeInteger(request.offset) || request.offset < 0) {
      log.info('code_intel_reference_page_finished', {
        requestId,
        result: 'invalid-offset',
        offset: request.offset,
        durationMs: Date.now() - startedAt,
      })
      return { ok: false, error: 'The reference offset must be a non-negative integer.' }
    }
    const pageStartedAt = Date.now()
    const page = languageState.store.referencesFor(request.symbol, request.offset)
    log.info('code_intel_reference_page_selected', {
      requestId,
      offset: request.offset,
      returnedReferenceCount: page.references.length,
      referenceCount: page.referenceCount,
      nextOffset: page.nextOffset,
      durationMs: Date.now() - pageStartedAt,
    })
    const references = page.references.length > 0
      ? await withReferencePreviews(rootState.root, page.references, {
          requestId,
          operation: 'references',
        })
      : []
    log.info('code_intel_reference_page_finished', {
      requestId,
      result: 'page',
      offset: request.offset,
      returnedReferenceCount: references.length,
      referenceCount: page.referenceCount,
      nextOffset: page.nextOffset,
      durationMs: Date.now() - startedAt,
    })
    return { ok: true, references, referenceCount: page.referenceCount, nextOffset: page.nextOffset }
  }

  async install(request: CodeIntelInstallRequest): Promise<CodeIntelStatus> {
    const adapter = CODE_INTEL_ADAPTERS.find((candidate) => candidate.language === request.language)
    if (!adapter) throw new Error(`Unsupported code-intelligence language: ${String(request.language)}`)

    const existing = this.installRuns.get(adapter.language)
    if (existing) return existing

    const run = installCodeIntelTool(adapter)
      .then(() => {
        for (const rootState of this.roots.values()) {
          const languageState = rootState.languages.get(adapter.language)!
          if (languageState.state === 'tool-missing') languageState.state = 'not-indexed'
          this.emit(rootState)
        }
        const status = this.hostSnapshot()
        this.notify(status)
        return status
      })
      .finally(() => {
        if (this.installRuns.get(adapter.language) === run) this.installRuns.delete(adapter.language)
      })
    this.installRuns.set(adapter.language, run)
    return run
  }

  async reindex(root: string, request: CodeIntelReindexRequest): Promise<CodeIntelStatus> {
    const rootState = await this.rootState(root)
    const targets = request.language
      ? [rootState.languages.get(request.language)!]
      : [...rootState.languages.values()].filter((languageState) => languageState.detected)
    for (const languageState of targets) {
      if (!resolveToolBinary(languageState.adapter, rootState.root)) {
        languageState.state = 'tool-missing'
        continue
      }
      this.startIndex(rootState, languageState, 'requested')
    }
    this.emit(rootState)
    return this.snapshot(rootState)
  }

  dispose(): void {
    for (const rootState of this.roots.values()) {
      for (const languageState of rootState.languages.values()) {
        languageState.run?.abort.abort()
        if (languageState.reindexTimer) clearTimeout(languageState.reindexTimer)
      }
    }
    this.roots.clear()
    this.listeners.clear()
  }

  // ─── Root lifecycle ───

  private async rootState(root: string): Promise<RootState> {
    const key = await realpath(root).catch(() => root)
    let rootState = this.roots.get(key)
    if (!rootState) {
      rootState = {
        root: key,
        cacheDir: cacheDirFor(key),
        languages: new Map(),
        loading: null,
      }
      for (const adapter of CODE_INTEL_ADAPTERS) {
        rootState.languages.set(adapter.language, {
          adapter,
          detected: detectLanguage(adapter, key),
          state: resolveToolBinary(adapter, key) ? 'not-indexed' : 'tool-missing',
          indexedAt: null,
          error: null,
          store: null,
          fileHashes: new Map(),
          run: null,
          lastAutoReindexAt: 0,
          reindexTimer: null,
        })
      }
      this.roots.set(key, rootState)
    }
    rootState.loading ??= this.loadFromDisk(rootState)
    await rootState.loading
    return rootState
  }

  private async loadFromDisk(rootState: RootState): Promise<void> {
    await Promise.all(
      [...rootState.languages.values()].map(async (languageState) => {
        if (!languageState.detected) return
        const language = languageState.adapter.language
        try {
          const [bytes, metaText] = await Promise.all([
            readFile(this.indexPath(rootState, language)),
            readFile(this.metaPath(rootState, language), 'utf-8'),
          ])
          // SAFETY: this process wrote the file from an IndexMeta in runIndex; a
          // foreign or corrupt file fails in adoptIndex and is treated as absent.
          const meta = JSON.parse(metaText) as IndexMeta
          this.adoptIndex(languageState, bytes, meta)
        } catch {
          // No cached index yet, or an unreadable one; the first query builds it.
        }
      }),
    )
  }

  private adoptIndex(languageState: LanguageState, bytes: Uint8Array, meta: IndexMeta): void {
    const decoded = decodeScipIndex(bytes)
    languageState.store = CodeIntelIndex.fromScip(languageState.adapter.language, decoded)
    languageState.fileHashes = new Map(meta.files.map((file) => [file.path, file.hash]))
    languageState.indexedAt = meta.indexedAt
    languageState.state = 'ready'
    languageState.error = null
  }

  // ─── Indexing ───

  private startIndex(rootState: RootState, languageState: LanguageState, reason: 'first-query' | 'requested' | 'stale'): void {
    if (languageState.run) return
    const abort = new AbortController()
    const run: IndexRun = { abort }
    languageState.run = run
    languageState.state = 'indexing'
    languageState.error = null
    log.info('code_intel_index_started', { root: rootState.root, language: languageState.adapter.language, reason })
    this.emit(rootState)
    void this.runIndex(rootState, languageState, abort.signal).finally(() => {
      if (languageState.run === run) languageState.run = null
    })
  }

  private async runIndex(rootState: RootState, languageState: LanguageState, signal: AbortSignal): Promise<void> {
    const { adapter } = languageState
    const language = adapter.language
    const startedAt = Date.now()
    const outputPath = this.indexPath(rootState, language)
    try {
      const binary = resolveToolBinary(adapter, rootState.root)
      if (!binary) throw new Error(`${adapter.toolName} is not installed`)
      await mkdir(rootState.cacheDir, { recursive: true })
      await rm(outputPath, { force: true })
      await this.spawnIndexer(binary, adapter.indexArgs(rootState.root, outputPath), rootState.root, signal)
      const bytes = await readFile(outputPath)
      const decoded = decodeScipIndex(bytes)
      const store = CodeIntelIndex.fromScip(language, decoded)
      const files = await this.hashDocuments(rootState.root, [...store.documentPaths()])
      const meta: IndexMeta = { indexedAt: Date.now(), files }
      await writeFile(this.metaPath(rootState, language), JSON.stringify(meta))
      if (signal.aborted) return
      languageState.store = store
      languageState.fileHashes = new Map(files.map((file) => [file.path, file.hash]))
      languageState.indexedAt = meta.indexedAt
      languageState.state = 'ready'
      languageState.error = null
      log.info('code_intel_index_finished', {
        root: rootState.root,
        language,
        documents: files.length,
        durationMs: Date.now() - startedAt,
      })
    } catch (error) {
      if (signal.aborted) return
      const message = error instanceof Error ? error.message : String(error)
      // A failed rebuild keeps the previous index answering; only its label changes.
      languageState.state = languageState.store ? 'stale' : 'error'
      languageState.error = message
      log.warn('code_intel_index_failed', { root: rootState.root, language, error: message })
    } finally {
      this.emit(rootState)
    }
  }

  private spawnIndexer(binary: string, args: string[], cwd: string, signal: AbortSignal): Promise<void> {
    return new Promise((resolvePromise, reject) => {
      const child = spawn(binary, args, { cwd, env: getCliEnv(), stdio: ['ignore', 'ignore', 'pipe'] })
      let stderrTail = ''
      child.stderr.setEncoding('utf-8')
      child.stderr.on('data', (chunk: string) => {
        stderrTail = (stderrTail + chunk).slice(-STDERR_TAIL_BYTES)
      })
      const timeout = setTimeout(() => {
        child.kill('SIGTERM')
        reject(new Error(`indexer timed out after ${INDEX_TIMEOUT_MS / 60_000} minutes`))
      }, INDEX_TIMEOUT_MS)
      timeout.unref()
      const onAbort = () => child.kill('SIGTERM')
      signal.addEventListener('abort', onAbort, { once: true })
      child.on('error', (error) => {
        clearTimeout(timeout)
        signal.removeEventListener('abort', onAbort)
        reject(error)
      })
      child.on('close', (code) => {
        clearTimeout(timeout)
        signal.removeEventListener('abort', onAbort)
        if (code === 0) resolvePromise()
        else reject(new Error(stderrTail.trim() || `indexer exited with code ${code}`))
      })
    })
  }

  private async hashDocuments(root: string, paths: string[]): Promise<IndexMeta['files']> {
    const files: IndexMeta['files'] = []
    for (let offset = 0; offset < paths.length; offset += HASH_CONCURRENCY) {
      const batch = paths.slice(offset, offset + HASH_CONCURRENCY)
      const hashes = await Promise.all(
        batch.map((path) => readFile(join(root, path)).then(hashContents, () => null)),
      )
      batch.forEach((path, index) => {
        const hash = hashes[index]
        if (hash) files.push({ path, hash })
      })
    }
    return files
  }

  // ─── Staleness ───

  private async freshnessOf(rootState: RootState, languageState: LanguageState, path: string): Promise<'fresh' | 'stale'> {
    const indexed = languageState.fileHashes.get(path)
    if (!indexed) return languageState.store?.hasDocument(path) ? 'stale' : 'fresh'
    const current = await readFile(join(rootState.root, path)).then(hashContents, () => null)
    return current === indexed ? 'fresh' : 'stale'
  }

  private scheduleAutoReindex(rootState: RootState, languageState: LanguageState): void {
    if (languageState.run || languageState.reindexTimer) return
    if (Date.now() - languageState.lastAutoReindexAt < AUTO_REINDEX_MIN_INTERVAL_MS) return
    if (!resolveToolBinary(languageState.adapter, rootState.root)) return
    languageState.reindexTimer = setTimeout(() => {
      languageState.reindexTimer = null
      languageState.lastAutoReindexAt = Date.now()
      this.startIndex(rootState, languageState, 'stale')
    }, STALE_REINDEX_DEBOUNCE_MS)
    languageState.reindexTimer.unref()
  }

  // ─── Status ───

  private snapshot(rootState: RootState): CodeIntelStatus {
    return {
      root: rootState.root,
      languages: [...rootState.languages.values()].map((languageState) => this.languageStatus(languageState)),
    }
  }

  private languageStatus(languageState: LanguageState): CodeIntelLanguageStatus {
    const { adapter } = languageState
    return {
      language: adapter.language,
      label: adapter.label,
      detected: languageState.detected,
      toolName: adapter.toolName,
      toolInstalled: languageState.state !== 'tool-missing',
      installCommand: adapter.installCommand,
      state: languageState.state,
      indexedAt: languageState.indexedAt,
      documentCount: languageState.store?.documentCount ?? 0,
      error: languageState.error,
    }
  }

  private hostOnlyStatus(adapter: CodeIntelAdapter): CodeIntelLanguageStatus {
    const installed = resolveToolBinary(adapter, null) !== null
    return {
      language: adapter.language,
      label: adapter.label,
      detected: false,
      toolName: adapter.toolName,
      toolInstalled: installed,
      installCommand: adapter.installCommand,
      state: installed ? 'not-indexed' : 'tool-missing',
      indexedAt: null,
      documentCount: 0,
      error: null,
    }
  }

  private hostSnapshot(): CodeIntelStatus {
    return {
      root: null,
      languages: CODE_INTEL_ADAPTERS.map((adapter) => this.hostOnlyStatus(adapter)),
    }
  }

  private emit(rootState: RootState): void {
    this.notify(this.snapshot(rootState))
  }

  private notify(status: CodeIntelStatus): void {
    for (const listener of this.listeners) {
      try {
        listener(status)
      } catch (error) {
        log.error('code_intel_status_listener_failed', { error: error instanceof Error ? error.message : String(error) })
      }
    }
  }

  // ─── Paths ───

  private indexPath(rootState: RootState, language: CodeIntelLanguage): string {
    return join(rootState.cacheDir, `${language}.scip`)
  }

  private metaPath(rootState: RootState, language: CodeIntelLanguage): string {
    return join(rootState.cacheDir, `${language}.meta.json`)
  }
}
