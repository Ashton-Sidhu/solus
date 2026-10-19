/**
 * Mobile compiler coverage — every component and hook the React Compiler
 * attempts in the native app either compiles or is a named, known skip.
 *
 * The compiler skips a whole function when one statement in it is outside
 * what it can prove, and it does so silently: the app still runs, with the
 * function's manual caches and no automatic ones. A cleanup that removes a
 * `useMemo` can therefore turn a compiled component into a skipped one with no
 * visible symptom. This check runs each native source through the installed
 * Expo Metro Babel transformer with the compiler on and compares the outcome
 * of each function, by name, with the reviewed baseline.
 *
 * The baseline only shrinks by itself. A function that starts to skip, or a
 * compiled function that disappears, must be named with `--accept` when the
 * baseline is written, so the reduction is a reviewed change in its diff.
 * Plan and vocabulary: `docs/plans/mobile-compiler-coverage.md`.
 *
 *   bun scripts/check-mobile-compiler-coverage.ts              check
 *   … --list                                                    every skip and its diagnostics
 *   … --update [--accept=<path>[#<function>]]…                  write the baseline
 *   … --semantics --report=<file.json>                          full evidence run
 *   … --all-platforms                                           Android for shared files too
 *   … --source-root=<dir>                                       cover a copy of the sources
 */
import { availableParallelism } from 'node:os'
import { createRequire } from 'node:module'
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, sep } from 'node:path'
import { Worker } from 'node:worker_threads'
import { z } from 'zod'
import { MOBILE_ROOT, type CliTransformOptions, type CoverageRequest, type FileCoverage, type NativePlatform } from './lib/mobile-compiler-transform'

export const BASELINE_PATH = 'scripts/mobile-compiler-coverage-baseline.json'

/** The packages whose code decides what the compiler does to a module. */
const TOOLCHAIN_PACKAGES = [
  '@babel/core',
  '@expo/cli',
  '@expo/metro-config',
  'babel-plugin-react-compiler',
  'babel-preset-expo',
  'react-native-reanimated',
  'react-native-worklets',
] as const

const SKIPPED_FUNCTION = z.object({ name: z.string(), reasons: z.array(z.string()) })
const FILE_BASELINE = z.object({ compiled: z.array(z.string()), skipped: z.array(SKIPPED_FUNCTION) })
const BASELINE = z.object({
  toolchain: z.record(z.string(), z.string()),
  files: z.record(z.string(), FILE_BASELINE),
})

export type FileBaseline = z.infer<typeof FILE_BASELINE>
export type CoverageBaseline = z.infer<typeof BASELINE>

export type CoverageChange =
  | { kind: 'new-skip'; path: string; name: string; reasons: string[] }
  | { kind: 'lost-compile'; path: string; name: string }
  | { kind: 'fixed-skip'; path: string; name: string }
  | { kind: 'gone-skip'; path: string; name: string }
  | { kind: 'new-compile'; path: string; name: string }
  | { kind: 'skip-reasons'; path: string; name: string; was: string[]; now: string[] }
  | { kind: 'toolchain'; name: string; was: string; now: string }

/** A change that lowers coverage. Writing it into the baseline needs `--accept`. */
export function lowersCoverage(change: CoverageChange): boolean {
  return change.kind === 'new-skip' || change.kind === 'lost-compile'
}

/** Every module Metro can bundle for iOS or Android from the app's own source. */
export function nativeSources(root: string): string[] {
  const sources = readdirSync(join(root, MOBILE_ROOT, 'src'), { recursive: true, encoding: 'utf8' })
    .map((path) => path.split(sep).join('/'))
    .filter((path) => /\.tsx?$/.test(path) && !path.endsWith('.d.ts') && !/\.(test|web)\.tsx?$/.test(path))
    .map((path) => `${MOBILE_ROOT}/src/${path}`)
  return [`${MOBILE_ROOT}/index.ts`, ...sources].sort()
}

/** `.ios`/`.android` modules exist for one platform; the rest are shared. */
export function platformsFor(path: string, allPlatforms: boolean): NativePlatform[] {
  if (/\.ios\.tsx?$/.test(path)) return ['ios']
  if (/\.android\.tsx?$/.test(path)) return ['android']
  return allPlatforms ? ['ios', 'android'] : ['ios']
}

type ExpoConfig = { experiments?: { reactCompiler?: boolean } }

function expoConfig(root: string): ExpoConfig {
  const { getConfig } = createRequire(join(root, MOBILE_ROOT, 'package.json'))('@expo/config')
  const config: { exp: ExpoConfig } = getConfig(join(root, MOBILE_ROOT), { skipSDKVersionRequirement: true, skipPlugins: true })
  return config.exp
}

/** `expo.experiments.reactCompiler`, the flag Expo CLI turns into the transform option. */
export function configuredCompiler(root: string): boolean {
  return expoConfig(root).experiments?.reactCompiler === true
}

export type CompilerMode = 'configured' | 'enabled' | 'disabled'

/**
 * The transformer options Expo CLI computes for a release bundle
 * (`expo export:embed`) from the app config. `enabled` and `disabled` change
 * only the compiler flag, so a preview differs from the shipped build in that
 * one input.
 */
export function cliTransformOptions(root: string, platform: NativePlatform, mode: CompilerMode): CliTransformOptions {
  const exp = expoConfig(root)
  const config = mode === 'configured' ? exp : { ...exp, experiments: { ...exp.experiments, reactCompiler: mode === 'enabled' } }
  const metroOptions = createRequire(join(root, MOBILE_ROOT, 'package.json'))('@expo/cli/build/src/start/server/middleware/metroOptions')
  const bundle: CliTransformOptions = metroOptions.getMetroDirectBundleOptionsForExpoConfig(join(root, MOBILE_ROOT), config, {
    platform, mode: 'production', engine: 'hermes', mainModuleName: 'index', isExporting: true, bytecode: false, splitChunks: false,
  })
  return {
    dev: bundle.dev,
    unstable_transformProfile: bundle.unstable_transformProfile,
    customTransformOptions: { ...bundle.customTransformOptions },
  }
}

export function toolchainVersions(root: string) {
  const mobileRequire = createRequire(join(root, MOBILE_ROOT, 'package.json'))
  return Object.fromEntries(TOOLCHAIN_PACKAGES.map((name) => {
    const manifest: { version: string } = mobileRequire(`${name}/package.json`)
    return [name, manifest.version]
  }))
}

function workerCount(): number {
  return Math.max(1, Math.min(4, availableParallelism() - 1))
}

/** Largest files first, each to the least loaded worker. */
function shares(root: string, requests: CoverageRequest[], count: number): CoverageRequest[][] {
  const sized = requests.map((request) => ({ request, size: readFileSync(join(root, request.path)).length }))
    .sort((a, b) => b.size - a.size)
  const buckets = Array.from({ length: count }, () => {
    const requests: CoverageRequest[] = []
    return { load: 0, requests }
  })
  for (const { request, size } of sized) {
    const lightest = buckets.reduce((min, bucket) => (bucket.load < min.load ? bucket : min))
    lightest.load += size
    lightest.requests.push(request)
  }
  return buckets.map((bucket) => bucket.requests).filter((share) => share.length > 0)
}

function coverShare(share: CoverageRequest[]): Promise<FileCoverage[]> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./lib/mobile-compiler-worker.ts', import.meta.url), { workerData: share })
    worker.once('message', (coverage: FileCoverage[]) => {
      resolve(coverage)
      void worker.terminate()
    })
    worker.once('error', reject)
    worker.once('exit', (code) => {
      if (code !== 0) reject(new Error(`compiler coverage worker exited with ${code}`))
    })
  })
}

export type CoverageRun = {
  root: string
  paths: string[]
  mode: CompilerMode
  semantics: boolean
  allPlatforms: boolean
}

export async function runCoverage(run: CoverageRun): Promise<FileCoverage[]> {
  const build = (platform: NativePlatform): Pick<CoverageRequest, 'options' | 'withoutCompiler'> => ({
    options: cliTransformOptions(run.root, platform, run.mode),
    withoutCompiler: run.semantics ? cliTransformOptions(run.root, platform, 'disabled') : null,
  })
  const builds = { ios: build('ios'), android: build('android') }
  const requests = run.paths.flatMap((path) => platformsFor(path, run.allPlatforms)
    .map((platform): CoverageRequest => ({ root: run.root, path, platform, ...builds[platform] })))
  const results = await Promise.all(shares(run.root, requests, workerCount()).map(coverShare))
  const platformOrder = (platform: NativePlatform): number => (platform === 'ios' ? 0 : 1)
  return results.flat().sort((a, b) => a.path.localeCompare(b.path) || platformOrder(a.platform) - platformOrder(b.platform))
}

/** One entry per file that has an attempted function; shared files use iOS, which sorts first. */
export function summarize(files: FileCoverage[]) {
  const summary = new Map<string, FileBaseline>()
  for (const file of files) {
    if (file.functions.length === 0 || summary.has(file.path)) continue
    summary.set(file.path, {
      compiled: file.functions.filter((fn) => fn.compiled).map((fn) => fn.name).sort(),
      skipped: file.functions.filter((fn) => !fn.compiled).map((fn) => ({ name: fn.name, reasons: fn.reasons }))
        .sort((a, b) => a.name.localeCompare(b.name)),
    })
  }
  return Object.fromEntries(summary)
}

function counts(names: string[]): Map<string, number> {
  const tally = new Map<string, number>()
  for (const name of names) tally.set(name, (tally.get(name) ?? 0) + 1)
  return tally
}

type FileOutcomes = {
  compiled: Map<string, number>
  skipped: Map<string, string[]>
}

function outcomesOf(file: FileBaseline | undefined): FileOutcomes {
  return { compiled: counts(file?.compiled ?? []), skipped: new Map((file?.skipped ?? []).map((fn) => [fn.name, fn.reasons])) }
}

function compareSkips(path: string, now: FileOutcomes, was: FileOutcomes): CoverageChange[] {
  const changes: CoverageChange[] = []
  for (const [name, reasons] of now.skipped) {
    const previous = was.skipped.get(name)
    if (!previous) changes.push({ kind: 'new-skip', path, name, reasons })
    else if (previous.join() !== reasons.join()) changes.push({ kind: 'skip-reasons', path, name, was: previous, now: reasons })
  }
  for (const name of was.skipped.keys()) {
    if (!now.skipped.has(name)) changes.push({ kind: now.compiled.has(name) ? 'fixed-skip' : 'gone-skip', path, name })
  }
  return changes
}

function compareCompiled(path: string, now: FileOutcomes, was: FileOutcomes): CoverageChange[] {
  const changes: CoverageChange[] = []
  for (const name of new Set([...now.compiled.keys(), ...was.compiled.keys()])) {
    const delta = (now.compiled.get(name) ?? 0) - (was.compiled.get(name) ?? 0)
    // A fixed skip already accounts for one more compiled function of that
    // name, and a new skip for one fewer.
    const fixed = was.skipped.has(name) && !now.skipped.has(name) ? 1 : 0
    const skippedAgain = now.skipped.has(name) && !was.skipped.has(name) ? 1 : 0
    for (let i = fixed; i < delta; i++) changes.push({ kind: 'new-compile', path, name })
    for (let i = skippedAgain; i < -delta; i++) changes.push({ kind: 'lost-compile', path, name })
  }
  return changes
}

function compareFile(path: string, now: FileBaseline | undefined, was: FileBaseline | undefined): CoverageChange[] {
  const outcomesNow = outcomesOf(now)
  const outcomesWas = outcomesOf(was)
  return [...compareSkips(path, outcomesNow, outcomesWas), ...compareCompiled(path, outcomesNow, outcomesWas)]
}

export function compareCoverage(
  files: { [path: string]: FileBaseline },
  toolchain: { [name: string]: string },
  baseline: CoverageBaseline,
): CoverageChange[] {
  const changes: CoverageChange[] = []
  for (const name of new Set([...Object.keys(toolchain), ...Object.keys(baseline.toolchain)])) {
    const was = baseline.toolchain[name] ?? 'absent'
    const now = toolchain[name] ?? 'absent'
    if (was !== now) changes.push({ kind: 'toolchain', name, was, now })
  }
  for (const path of [...new Set([...Object.keys(files), ...Object.keys(baseline.files)])].sort()) {
    changes.push(...compareFile(path, files[path], baseline.files[path]))
  }
  return changes
}

/**
 * `--accept=<path>#<function>` accepts one reduction; `--accept=<path prefix>`
 * accepts every reduction in the files under it, such as a moved folder.
 */
export function unacceptedReductions(changes: CoverageChange[], accepted: string[]): CoverageChange[] {
  const isAccepted = (path: string, name: string): boolean => accepted.some((entry) =>
    entry.includes('#') ? entry === `${path}#${name}` : path.startsWith(entry))
  return changes.filter((change) => lowersCoverage(change) && 'path' in change && !isAccepted(change.path, change.name))
}

/**
 * Facts that must hold for any outcome, so a logger that missed the compiler,
 * a module-level opt-out, or a semantic change cannot pass as coverage.
 */
export function consistencyProblems(files: FileCoverage[], compiler: boolean): string[] {
  const problems: string[] = []
  for (const file of files) {
    const where = `${file.path} (${file.platform})`
    if (file.compilerPlugin !== compiler) problems.push(`${where}: compiler plugin ${file.compilerPlugin ? 'ran' : 'did not run'}`)
    const withSlots = file.functions.filter((fn) => fn.compiled && fn.memoSlots > 0).length
    if (withSlots !== file.memoCacheCalls) {
      problems.push(`${where}: ${withSlots} compiled functions use memo slots, but the module has ${file.memoCacheCalls} memo caches`)
    }
    const semantics = file.semantics
    if (!semantics) continue
    if (!semantics.observerPassive) problems.push(`${where}: the logger changed the transformer output`)
    if (JSON.stringify(semantics.interfaceWithCompiler) !== JSON.stringify(semantics.interfaceWithoutCompiler)) {
      problems.push(`${where}: the compiler changed what the module requires or exports`)
    }
    for (const miss of semantics.sourceMap.misses) problems.push(`${where}: source map ${miss}`)
  }
  return problems
}

/** Shared files must compile the same way for both platforms. */
export function platformDivergence(files: FileCoverage[]): string[] {
  const byPath = new Map<string, FileCoverage[]>()
  for (const file of files) byPath.set(file.path, [...(byPath.get(file.path) ?? []), file])
  const divergent: string[] = []
  for (const [path, variants] of byPath) {
    const outcomes = variants.map((file) => JSON.stringify(summarize([file])[path] ?? null))
    if (new Set(outcomes).size > 1) divergent.push(path)
  }
  return divergent
}

/** No file yet reads as an empty baseline, so adoption names what it accepts. */
export function readBaseline(root: string): CoverageBaseline {
  if (!existsSync(join(root, BASELINE_PATH))) return { toolchain: {}, files: {} }
  return BASELINE.parse(JSON.parse(readFileSync(join(root, BASELINE_PATH), 'utf8')))
}

export function describeChange(change: CoverageChange): string {
  switch (change.kind) {
    case 'new-skip': return `${change.path}: ${change.name} no longer compiles (${change.reasons.join(', ')})`
    case 'lost-compile': return `${change.path}: compiled function ${change.name} is gone`
    case 'fixed-skip': return `${change.path}: ${change.name} compiles now — remove its known skip with --update`
    case 'gone-skip': return `${change.path}: skipped function ${change.name} is gone — remove its known skip with --update`
    case 'new-compile': return `${change.path}: ${change.name} compiles — record it with --update`
    case 'skip-reasons': return `${change.path}: ${change.name} skips for ${change.now.join(', ')}, not ${change.was.join(', ')}`
    case 'toolchain': return `${change.name} is ${change.now}; the baseline was measured with ${change.was}`
  }
}

type Totals = {
  files: number
  attempted: number
  compiled: number
  skipped: number
  /**
   * Babel output before minification for the modules that compile anything,
   * with and without the compiler. Not bundle or Hermes bytecode size.
   */
  compiledModules: { files: number; bytesWithCompiler: number; bytesWithoutCompiler: number } | null
  sourceMap: { located: number; mapped: number } | null
}

export function totals(files: FileCoverage[]): Totals {
  const functions = files.flatMap((file) => file.functions)
  const measured = files.flatMap((file) => (file.semantics ? [{ file, semantics: file.semantics }] : []))
  return {
    files: files.length,
    attempted: functions.length,
    compiled: functions.filter((fn) => fn.compiled).length,
    skipped: functions.filter((fn) => !fn.compiled).length,
    compiledModules: measured.length ? {
      files: measured.length,
      bytesWithCompiler: measured.reduce((sum, { file }) => sum + file.outputBytes, 0),
      bytesWithoutCompiler: measured.reduce((sum, { semantics }) => sum + semantics.outputBytesWithoutCompiler, 0),
    } : null,
    sourceMap: measured.length ? {
      located: measured.reduce((sum, { semantics }) => sum + semantics.sourceMap.located, 0),
      mapped: measured.reduce((sum, { semantics }) => sum + semantics.sourceMap.mapped, 0),
    } : null,
  }
}

function printSkips(files: FileCoverage[]): void {
  for (const file of files) {
    for (const fn of file.functions.filter((outcome) => !outcome.compiled)) {
      console.log(`\n${file.path}:${fn.line} ${fn.name} (${fn.reasons.join(', ')})`)
      for (const diagnostic of fn.diagnostics) console.log(`  ${diagnostic.line ?? '?'}: [${diagnostic.category}] ${diagnostic.reason}`)
    }
  }
}

function optionValues(name: string): string[] {
  return process.argv.filter((arg) => arg.startsWith(`--${name}=`)).map((arg) => arg.slice(name.length + 3))
}

async function main(): Promise<void> {
  const root = process.cwd()
  // A copy of the app's sources, such as a before snapshot, with the real
  // node_modules linked in. The baseline is always the repository's.
  const [sourceRoot = root] = optionValues('source-root')
  const semantics = process.argv.includes('--semantics')
  const allPlatforms = process.argv.includes('--all-platforms')
  const startedAt = performance.now()
  const files = await runCoverage({ root: sourceRoot, paths: nativeSources(sourceRoot), mode: 'enabled', semantics, allPlatforms })
  const seconds = ((performance.now() - startedAt) / 1000).toFixed(1)
  const summary = summarize(files)
  const toolchain = toolchainVersions(sourceRoot)
  const problems = consistencyProblems(files, true)
  const divergent = allPlatforms ? platformDivergence(files) : []
  const sum = totals(files)
  console.log(`mobile compiler coverage: ${sum.compiled} compiled, ${sum.skipped} skipped, ${sum.files} modules, ${seconds}s`)

  const [reportPath] = optionValues('report')
  if (reportPath) {
    const report = { createdAt: new Date().toISOString(), sourceRoot, configuredCompiler: configuredCompiler(sourceRoot), toolchain, allPlatforms, semantics, totals: sum, problems, divergent, files }
    writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`)
    console.log(`report written to ${reportPath}`)
  }
  if (process.argv.includes('--list')) printSkips(files)
  for (const problem of problems) console.log(`problem: ${problem}`)
  for (const path of divergent) console.log(`platform divergence: ${path} compiles differently on iOS and Android`)

  const changes = compareCoverage(summary, toolchain, readBaseline(root))
  if (process.argv.includes('--update')) {
    const refused = unacceptedReductions(changes, optionValues('accept'))
    for (const change of refused) console.log(`refused: ${describeChange(change)}`)
    if (refused.length > 0 || problems.length > 0) {
      console.log('\nName each reduction with --accept=<path>#<function> after review; fix every problem first.')
      process.exit(1)
    }
    writeFileSync(join(root, BASELINE_PATH), `${JSON.stringify({ toolchain, files: summary }, null, 2)}\n`)
    for (const change of changes) console.log(`recorded: ${describeChange(change)}`)
    console.log(`baseline written to ${BASELINE_PATH}`)
    return
  }
  for (const change of changes) console.log(describeChange(change))
  if (changes.length > 0 || problems.length > 0 || divergent.length > 0) process.exit(1)
}

if (import.meta.main) await main()
