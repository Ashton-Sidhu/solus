/**
 * One native source file through the installed Expo Metro Babel transformer,
 * with the React Compiler's own logger attached.
 *
 * The transformer reads the real `apps/mobile/babel.config.js` and builds its
 * own Babel caller, so the result is what Metro would produce for that file.
 * The compiler only reports per-function outcomes through a logger in its
 * plugin options, and the app's Babel config passes none. A first plugin
 * finds the compiler's plugin instance before traversal and lends it a logger
 * for this file only; `post` takes it back. That plugin writes nothing to the
 * AST, and the semantics pass proves the output is byte-identical without it.
 *
 * Used by `scripts/check-mobile-compiler-coverage.ts` and its worker.
 */
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import type { parse } from '@babel/parser'
import type * as BabelTypes from '@babel/types'
import type * as TraceMapping from '@jridgewell/trace-mapping'
import type { LoggerEvent, SourceLocation as CompilerLocation } from 'babel-plugin-react-compiler'

export const MOBILE_ROOT = 'apps/mobile'

export type NativePlatform = 'ios' | 'android'

/** One function the compiler attempted, keyed by name rather than line. */
export type FunctionOutcome = {
  name: string
  line: number
  compiled: boolean
  memoSlots: number
  /** Distinct diagnostic categories that stopped the function, sorted. */
  reasons: string[]
  /** Every diagnostic, in source order, for reports and stage work queues. */
  diagnostics: Diagnostic[]
}

export type Diagnostic = {
  category: string
  reason: string
  line: number | null
}

export type ModuleInterface = {
  requires: string[]
  exports: string[]
}

export type SourceMapCheck = {
  /** Compiled functions whose declaration was found in the generated code. */
  located: number
  /** Of those, how many map back to the function's original line. */
  mapped: number
  misses: string[]
}

export type FileSemantics = {
  outputBytesWithoutCompiler: number
  /** Interface of the compiler-off output; the compiled output must match it. */
  interfaceWithoutCompiler: ModuleInterface
  interfaceWithCompiler: ModuleInterface
  sourceMap: SourceMapCheck
  /** The observer plugin changed no output byte. */
  observerPassive: boolean
}

export type FileCoverage = {
  path: string
  platform: NativePlatform
  compilerPlugin: boolean
  functions: FunctionOutcome[]
  /** `_c(n)` calls in the generated module: one per compiled function with slots. */
  memoCacheCalls: number
  outputBytes: number
  /** Present when the run asked for the compiler-off comparison. */
  semantics?: FileSemantics
}

/** What Expo CLI hands Metro's transformer for one platform; see `cliTransformOptions`. */
export type CliTransformOptions = {
  dev: boolean
  unstable_transformProfile: string
  customTransformOptions: { [name: string]: string }
}

export type CoverageRequest = {
  root: string
  path: string
  platform: NativePlatform
  options: CliTransformOptions
  /** Set for the semantics pass: the same build with the compiler off. */
  withoutCompiler: CliTransformOptions | null
}

type CompilerPluginInstance = {
  key: string | null
  options: { logger?: { logEvent: (filename: string | null, event: LoggerEvent) => void } }
}

type ObserverPlugin = () => {
  name: string
  pre: (file: { opts: { plugins: CompilerPluginInstance[] } }) => void
  post: () => void
}

type TransformArgs = {
  filename: string
  src: string
  plugins: ObserverPlugin[]
  options: CliTransformOptions & {
    projectRoot: string
    platform: NativePlatform
    hot: boolean
    minify: boolean
    type: 'module'
    enableBabelRCLookup: boolean
    experimentalImportSupport: boolean
    inlineRequires: boolean
  }
}

type GeneratedModule = { code: string; map: TraceMapping.EncodedSourceMap | null }

export type MobileToolchain = {
  transformer: { transform: (args: TransformArgs) => { ast: BabelTypes.File } }
  generate: (ast: BabelTypes.File, options: { compact?: boolean; sourceMaps?: boolean; sourceFileName?: string }, source?: string) => GeneratedModule
  parse: typeof parse
  types: typeof BabelTypes
  traceMapping: typeof TraceMapping
}

/** Babel and the transformer resolve from the app, as Metro would load them. */
export function mobileToolchain(root: string): MobileToolchain {
  const mobileRequire = createRequire(join(root, MOBILE_ROOT, 'package.json'))
  return {
    transformer: mobileRequire('@expo/metro-config/babel-transformer'),
    generate: mobileRequire('@babel/generator').default,
    parse: mobileRequire('@babel/parser').parse,
    types: mobileRequire('@babel/types'),
    traceMapping: mobileRequire('@jridgewell/trace-mapping'),
  }
}

/**
 * One module as Metro's worker hands it to the Babel transformer. Metro
 * minifies after Babel, so the transformer itself never minifies.
 */
function transformArgs(request: CoverageRequest, options: CliTransformOptions): Omit<TransformArgs, 'plugins'> {
  const filename = join(request.root, request.path)
  return {
    filename,
    src: readFileSync(filename, 'utf8'),
    options: {
      ...options,
      projectRoot: join(request.root, MOBILE_ROOT),
      platform: request.platform,
      hot: false,
      minify: false,
      type: 'module',
      enableBabelRCLookup: true,
      experimentalImportSupport: false,
      inlineRequires: false,
    },
  }
}

/**
 * Lends the compiler a logger for one file. Babel lists every resolved plugin
 * instance on `file.opts.plugins`, and the compiler reads its options from that
 * instance when its Program visitor starts, after every `pre` hook has run.
 */
function observer(events: LoggerEvent[], found: { compilerPlugins: number }): ObserverPlugin {
  return () => {
    let lent: CompilerPluginInstance[] = []
    return {
      name: 'solus-compiler-coverage-observer',
      pre(file) {
        lent = file.opts.plugins.filter((plugin) => plugin.key === 'react-forget')
        found.compilerPlugins = lent.length
        for (const plugin of lent) plugin.options.logger = { logEvent: (_filename, event) => { events.push(event) } }
      },
      post() {
        for (const plugin of lent) delete plugin.options.logger
        lent = []
      },
    }
  }
}

const MEMO_CACHE_CALL = /\b_compilerRuntime\d*\.c\)\(/g
// The compiler prints string literals it rebuilds with double quotes, while
// untouched ones keep the source's quote, so both quotes must match.
const REQUIRE_CALL = /\brequire\((?:"([^"]+)"|'([^']+)')\)/g
const EXPORT_ASSIGNMENT = /\bexports\.([A-Za-z_$][\w$]*)\s*=(?!=)/g
const EXPORT_PROPERTY = /Object\.defineProperty\(exports,\s*(?:"([^"]+)"|'([^']+)')/g
const COMPILER_RUNTIME = 'react/compiler-runtime'

function captures(code: string, pattern: RegExp): string[] {
  return [...code.matchAll(pattern)].map((match) => match[1] ?? match[2])
}

/** What other modules can see: what it requires and what it exports. */
export function moduleInterface(code: string): ModuleInterface {
  return {
    requires: [...new Set(captures(code, REQUIRE_CALL))].filter((specifier) => specifier !== COMPILER_RUNTIME).sort(),
    exports: [...new Set([...captures(code, EXPORT_ASSIGNMENT), ...captures(code, EXPORT_PROPERTY)])]
      .filter((name) => name !== '__esModule').sort(),
  }
}

function positionKey(position: { line: number; column: number }): string {
  return `${position.line}:${position.column}`
}

function identifierName(types: typeof BabelTypes, node: BabelTypes.Node | null | undefined): string | null {
  return node && types.isIdentifier(node) ? node.name : null
}

function nameOf(types: typeof BabelTypes, fn: BabelTypes.Function, ancestors: BabelTypes.TraversalAncestors): string {
  const parent = ancestors.at(-1)?.node
  const grandparent = ancestors.at(-2)?.node
  const own = 'id' in fn ? identifierName(types, fn.id) : null
  if (own) return own
  if ((types.isObjectMethod(fn) || types.isClassMethod(fn)) && identifierName(types, fn.key)) return identifierName(types, fn.key) ?? ''
  if (parent && types.isVariableDeclarator(parent)) return identifierName(types, parent.id) ?? '<anonymous>'
  // `const Row = memo((props) => …)` and `forwardRef(…)`.
  if (parent && grandparent && types.isCallExpression(parent) && types.isVariableDeclarator(grandparent)) {
    return identifierName(types, grandparent.id) ?? '<anonymous>'
  }
  if (parent && types.isExportDefaultDeclaration(parent)) return 'default'
  return '<anonymous>'
}

/**
 * Names for function locations. Compile errors carry only a location, and a
 * baseline keyed by line would churn on every unrelated edit above it.
 * A skip event points at the function body, so both starts are recorded.
 */
export function functionNames(tools: MobileToolchain, source: string): Map<string, string> {
  const names = new Map<string, string>()
  const file = tools.parse(source, { sourceType: 'module', plugins: ['typescript', 'jsx'] })
  tools.types.traverse(file, (node, ancestors) => {
    if (!tools.types.isFunction(node) || !node.loc) return
    const name = nameOf(tools.types, node, ancestors)
    names.set(positionKey(node.loc.start), name)
    if (node.body.loc) names.set(positionKey(node.body.loc.start), name)
  })
  return names
}

/** The compiler marks synthesized code with a symbol in place of a location. */
function lineOf(location: CompilerLocation | null | undefined): number | null {
  const range: { start?: { line: number } } = Object(location)
  return range.start?.line ?? null
}

function diagnosticOf(event: LoggerEvent): Diagnostic | null {
  switch (event.kind) {
    case 'CompileError':
      return { category: event.detail.category, reason: event.detail.reason, line: lineOf(event.detail.primaryLocation()) }
    case 'CompileDiagnostic':
      return { category: event.detail.category, reason: event.detail.reason, line: lineOf(event.detail.loc) }
    case 'CompileSkip':
      return { category: 'OptOut', reason: event.reason, line: lineOf(event.loc) }
    case 'PipelineError':
      return { category: 'PipelineError', reason: event.data.split('\n')[0] ?? '', line: null }
    default:
      return null
  }
}

function eventLocation(event: LoggerEvent): BabelTypes.SourceLocation | null {
  return 'fnLoc' in event ? event.fnLoc : null
}

/** Groups the compiler's events into one outcome per attempted function. */
export function functionOutcomes(events: LoggerEvent[], names: () => Map<string, string>): FunctionOutcome[] {
  const byFunction = new Map<string, FunctionOutcome>()
  const outcomeAt = (location: BabelTypes.SourceLocation | null, reportedName: string | null): FunctionOutcome => {
    const key = location ? positionKey(location.start) : '<module>'
    let outcome = byFunction.get(key)
    if (!outcome) {
      const name = reportedName ?? (location ? names().get(key) ?? '<anonymous>' : '<module>')
      outcome = { name, line: location?.start.line ?? 0, compiled: false, memoSlots: 0, reasons: [], diagnostics: [] }
      byFunction.set(key, outcome)
    }
    return outcome
  }
  for (const event of events) {
    if (event.kind === 'CompileSuccess') {
      const outcome = outcomeAt(event.fnLoc, event.fnName)
      outcome.compiled = true
      outcome.memoSlots = event.memoSlots
      continue
    }
    const diagnostic = diagnosticOf(event)
    if (diagnostic) outcomeAt(eventLocation(event), null).diagnostics.push(diagnostic)
  }
  const outcomes = [...byFunction.values()]
  for (const outcome of outcomes) {
    // A non-fatal CompileDiagnostic does not stop a function that compiled.
    if (!outcome.compiled) outcome.reasons = [...new Set(outcome.diagnostics.map((diagnostic) => diagnostic.category))].sort()
  }
  return outcomes.sort((a, b) => a.line - b.line || a.name.localeCompare(b.name))
}

/** Where a compiled function's declaration lands in the generated code. */
function declarationPosition(lines: string[], name: string): { line: number; column: number } | null {
  if (!/^[A-Za-z_$][\w$]*$/.test(name)) return null
  const declaration = new RegExp(`\\bfunction ${name.replaceAll('$', '\\$')}\\(|\\b(?:const|let|var) ${name.replaceAll('$', '\\$')} = `)
  for (let index = 0; index < lines.length; index++) {
    const match = declaration.exec(lines[index])
    if (match) return { line: index + 1, column: match.index + match[0].indexOf(name) }
  }
  return null
}

function sourceMapCheck(tools: MobileToolchain, generated: GeneratedModule, functions: FunctionOutcome[]): SourceMapCheck {
  const check: SourceMapCheck = { located: 0, mapped: 0, misses: [] }
  if (!generated.map) return { ...check, misses: ['<no source map>'] }
  const map = new tools.traceMapping.TraceMap(generated.map)
  const lines = generated.code.split('\n')
  for (const fn of functions.filter((outcome) => outcome.compiled)) {
    const position = declarationPosition(lines, fn.name)
    if (!position) continue
    check.located++
    const original = tools.traceMapping.originalPositionFor(map, position)
    if (original.line === fn.line) check.mapped++
    else check.misses.push(`${fn.name}: line ${fn.line} maps from ${original.line ?? 'nothing'}`)
  }
  return check
}

function compact(tools: MobileToolchain, args: Omit<TransformArgs, 'plugins'>, plugins: ObserverPlugin[]): string {
  return tools.generate(tools.transformer.transform({ ...args, plugins }).ast, { compact: true }).code
}

export function coverFile(tools: MobileToolchain, request: CoverageRequest): FileCoverage {
  const args = transformArgs(request, request.options)
  const events: LoggerEvent[] = []
  const found = { compilerPlugins: 0 }
  const observed = tools.transformer.transform({ ...args, plugins: [observer(events, found)] })
  const code = tools.generate(observed.ast, { compact: true }).code
  let names: Map<string, string> | null = null
  const functions = functionOutcomes(events, () => (names ??= functionNames(tools, args.src)))
  const coverage: FileCoverage = {
    path: request.path,
    platform: request.platform,
    compilerPlugin: found.compilerPlugins > 0,
    functions,
    memoCacheCalls: code.match(MEMO_CACHE_CALL)?.length ?? 0,
    outputBytes: Buffer.byteLength(code),
  }
  if (!request.withoutCompiler || !functions.some((fn) => fn.compiled)) return coverage
  const withoutCompiler = compact(tools, transformArgs(request, request.withoutCompiler), [])
  const mapped = tools.generate(observed.ast, { sourceMaps: true, sourceFileName: args.filename }, args.src)
  coverage.semantics = {
    outputBytesWithoutCompiler: Buffer.byteLength(withoutCompiler),
    interfaceWithoutCompiler: moduleInterface(withoutCompiler),
    interfaceWithCompiler: moduleInterface(code),
    sourceMap: sourceMapCheck(tools, mapped, functions),
    observerPassive: compact(tools, args, []) === code,
  }
  return coverage
}
