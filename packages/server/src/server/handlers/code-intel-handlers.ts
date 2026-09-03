import type {
  CodeIntelDocsResult,
  CodeIntelInstallResult,
  CodeIntelReferencesResult,
  CodeIntelReindexResult,
  CodeIntelSymbolResult,
} from '@solus/contracts/code-intel'
import { randomUUID } from 'crypto'
import type { CodeIntelManager } from '../../code-intel/code-intel-manager'
import { MdnReader } from '../../code-intel/mdn-reader'
import { createLogger } from '../../logger'
import type { SolusServer } from '../server'
import { projectRootForRequest, resolvePreviewPath } from './lib/file-preview'

export interface CodeIntelDeps {
  codeIntel: CodeIntelManager
}

const NO_PROJECT = 'No project directory is available.'
const log = createLogger('code-intel', 'code-intel-handlers.ts')

function responseBytes(result: CodeIntelSymbolResult | CodeIntelReferencesResult): number {
  return Buffer.byteLength(JSON.stringify(result), 'utf-8')
}

/** Symbol navigation over the host's SCIP indexes. Headless-safe: nothing here
 *  needs a window, so a paired client gets the same answers as the desktop. */
export function registerCodeIntelHandlers(server: SolusServer, deps: CodeIntelDeps): void {
  // The reference reader is host-wide, not per-root: MDN does not care which
  // project the symbol was clicked in, and one cache serves every client.
  const mdn = new MdnReader()

  server.register('codeIntelSymbolAt', async (args): Promise<CodeIntelSymbolResult> => {
    const [ctx, request] = args
    const requestId = randomUUID()
    const startedAt = Date.now()
    const root = projectRootForRequest(ctx, request.cwd)
    log.info('code_intel_symbol_rpc_received', {
      requestId,
      sessionId: ctx.session.sessionId,
      root,
      path: request.path,
      line: request.line,
      character: request.character,
    })
    if (!root) {
      const result: CodeIntelSymbolResult = { ok: false, error: NO_PROJECT }
      log.info('code_intel_symbol_rpc_response_ready', {
        requestId,
        ok: false,
        responseBytes: responseBytes(result),
        durationMs: Date.now() - startedAt,
      })
      return result
    }
    try {
      const result = await deps.codeIntel.symbolAt(root, request, requestId)
      log.info('code_intel_symbol_rpc_response_ready', {
        requestId,
        ok: result.ok,
        hasSymbol: result.ok && result.symbol !== null,
        referenceCount: result.ok ? (result.symbol?.referenceCount ?? 0) : 0,
        returnedReferenceCount: result.ok ? (result.symbol?.references.length ?? 0) : 0,
        responseBytes: responseBytes(result),
        durationMs: Date.now() - startedAt,
      })
      return result
    } catch (error) {
      const result: CodeIntelSymbolResult = { ok: false, error: error instanceof Error ? error.message : String(error) }
      log.warn('code_intel_symbol_rpc_failed', {
        requestId,
        error: result.error,
        durationMs: Date.now() - startedAt,
      })
      return result
    }
  })

  server.register('codeIntelReferences', async (args): Promise<CodeIntelReferencesResult> => {
    const [ctx, request] = args
    const requestId = randomUUID()
    const startedAt = Date.now()
    const root = projectRootForRequest(ctx, request.cwd)
    log.info('code_intel_references_rpc_received', {
      requestId,
      sessionId: ctx.session.sessionId,
      root,
      language: request.language,
      offset: request.offset,
    })
    if (!root) {
      const result: CodeIntelReferencesResult = { ok: false, error: NO_PROJECT }
      log.info('code_intel_references_rpc_response_ready', {
        requestId,
        ok: false,
        responseBytes: responseBytes(result),
        durationMs: Date.now() - startedAt,
      })
      return result
    }
    try {
      const result = await deps.codeIntel.references(root, request, requestId)
      log.info('code_intel_references_rpc_response_ready', {
        requestId,
        ok: result.ok,
        returnedReferenceCount: result.ok ? result.references.length : 0,
        referenceCount: result.ok ? result.referenceCount : 0,
        nextOffset: result.ok ? result.nextOffset : null,
        responseBytes: responseBytes(result),
        durationMs: Date.now() - startedAt,
      })
      return result
    } catch (error) {
      const result: CodeIntelReferencesResult = { ok: false, error: error instanceof Error ? error.message : String(error) }
      log.warn('code_intel_references_rpc_failed', {
        requestId,
        error: result.error,
        durationMs: Date.now() - startedAt,
      })
      return result
    }
  })

  server.register('codeIntelDocs', async (args): Promise<CodeIntelDocsResult> => {
    const [request] = args
    try {
      return { ok: true, docs: await mdn.summaryFor(request.reference) }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  server.register('codeIntelStatus', async (args) => {
    const [ctx, request] = args
    const root = ctx
      ? projectRootForRequest(ctx, request?.cwd)
      : request?.cwd
        ? resolvePreviewPath(request.cwd, undefined)
        : null
    return deps.codeIntel.status(root)
  })

  server.register('codeIntelInstall', async (args): Promise<CodeIntelInstallResult> => {
    const [request] = args
    try {
      return { ok: true, status: await deps.codeIntel.install(request) }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  server.register('codeIntelReindex', async (args): Promise<CodeIntelReindexResult> => {
    const [ctx, request] = args
    const root = projectRootForRequest(ctx, request?.cwd)
    if (!root) return { ok: false, error: NO_PROJECT }
    try {
      return { ok: true, status: await deps.codeIntel.reindex(root, request ?? {}) }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  })
}
