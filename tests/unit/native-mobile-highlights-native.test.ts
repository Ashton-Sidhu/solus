import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createHighlighter } from '@pierre/highlights'
import { HIGHLIGHTS_LANGUAGE_IDS } from '../../apps/mobile/src/lib/highlights.generated'

/**
 * The mobile app runs @pierre/highlights as C (`modules/solus-highlights`):
 * wasm2c's translation of the package's WebAssembly, the module's own glue in
 * `cpp/solus_highlights.c`, and its generated Unicode tables. Web runs the
 * WebAssembly. This test compiles the module's C with the defines the iOS and
 * Android builds use and checks that it returns the same records as the
 * WebAssembly for every lexer, so mobile cannot color code differently from web.
 */

const root = resolve(import.meta.dir, '../..')
const moduleRoot = join(root, 'apps/mobile/modules/solus-highlights')
const hasCompiler = spawnSync('cc', ['--version']).status === 0

// The line-record API of the highlighter, which `Highlighter` does not declare.
interface LineRecordHighlighter {
  writeInput(input: string | Uint8Array): number
  tokenizeLineRecords(language: number, byteLength: number): Uint32Array
}

interface HighlightCase {
  readonly name: string
  readonly language: number
  readonly source: Uint8Array
}

const POLYGLOT = [
  '/** 🎉 docs for `greet` */\r',
  'export const greet = (name: string) => <b title={`hi ${name}`}>é</b>;',
  'const multi = `first',
  'second ${1 + 2}`; // done',
  'def π_value(x): return f"{x!r}" # comment',
  'SELECT id, "name" FROM users WHERE id = 0x1F; -- note',
  '<div class="a" data-x=\'1\'><!-- c --></div>',
  '# Heading\n- item **bold** _it_ [link](https://x.y)',
  'key: value # yaml\n  - 1.5e-3',
  'fn main() { let s = r#"raw"#; println!("{s}"); }',
  'if [ -n "$HOME" ]; then echo \'$x\' | grep -E "a+"; fi',
  'let 变量 = 1; const ŝtar‍x = /re[gx]+/gi;',
  '\tindented nbsp \u0000 nul \r lone cr',
  `long = "${'x'.repeat(1_200)}"`,
  '',
].join('\n')

/** A deterministic byte stream: malformed UTF-8 for the lexers' fallbacks. */
function fuzzBytes(seed: number, length: number): Uint8Array {
  const bytes = new Uint8Array(length)
  let state = seed
  for (let index = 0; index < length; index += 1) {
    state = (state * 1_103_515_245 + 12_345) >>> 0
    bytes[index] = state >>> 24
  }
  return bytes
}

type HighlightsLanguage = keyof typeof HIGHLIGHTS_LANGUAGE_IDS

function repositorySources(): ReadonlyArray<{ path: string; language: HighlightsLanguage }> {
  const byExtension: ReadonlyArray<readonly [string, HighlightsLanguage]> = [
    ['ts', 'typescript'], ['tsx', 'tsx'], ['swift', 'swift'], ['kt', 'kotlin'], ['c', 'c'],
    ['json', 'json'], ['md', 'markdown'], ['css', 'css'], ['svelte', 'svelte'], ['sh', 'bash'],
  ]
  const sources: Array<{ path: string; language: HighlightsLanguage }> = []
  for (const [extension, language] of byExtension) {
    const glob = new Bun.Glob(`{apps/mobile/src,apps/mobile/modules,packages/workspace-ui/src,scripts}/**/*.${extension}`)
    let count = 0
    for (const path of glob.scanSync({ cwd: root })) {
      if (path.includes('/Vendor/') || count === 3) continue
      sources.push({ path, language })
      count += 1
    }
  }
  return sources
}

function buildCases(): HighlightCase[] {
  const encoder = new TextEncoder()
  const languages = new Map<number, string>()
  for (const [name, id] of Object.entries(HIGHLIGHTS_LANGUAGE_IDS)) if (!languages.has(id)) languages.set(id, name)
  const cases: HighlightCase[] = []
  for (const [language, name] of languages) {
    cases.push({ name: `${name}: polyglot`, language, source: encoder.encode(POLYGLOT) })
    for (let end = 0; end < POLYGLOT.length; end += 97) {
      cases.push({ name: `${name}: polyglot to ${end}`, language, source: encoder.encode(POLYGLOT.slice(0, end)) })
    }
    cases.push({ name: `${name}: malformed UTF-8`, language, source: fuzzBytes(language + 1, 4_096) })
  }
  for (const { path, language } of repositorySources()) {
    cases.push({ name: path, language: HIGHLIGHTS_LANGUAGE_IDS[language], source: readFileSync(join(root, path)) })
  }
  // Grows the lexer's memory past the wrapper's reset limit (128 pages); the
  // next, small input then runs on a fresh instance.
  const typescript = HIGHLIGHTS_LANGUAGE_IDS.typescript
  cases.push({ name: 'large input', language: typescript, source: encoder.encode('const value = `x`; // y\n'.repeat(360_000)) })
  cases.push({ name: 'small input after a large one', language: typescript, source: encoder.encode('let a = 1;') })
  return cases
}

describe.skipIf(!hasCompiler)('native highlights build', () => {
  let directory: string
  let executable: string

  beforeAll(() => {
    directory = mkdtempSync(join(tmpdir(), 'solus-highlights-test-'))
    executable = join(directory, 'highlights-harness')
    // The defines and optimization of the podspec and CMakeLists.txt.
    execFileSync('cc', [
      '-O2', '-std=c11', '-w',
      '-DWASM_RT_USE_MMAP=0', '-DWASM_RT_MEMCHECK_BOUNDS_CHECK=1', '-DWASM_RT_SKIP_SIGNAL_RECOVERY=1',
      `-I${join(moduleRoot, 'cpp')}`, `-I${join(moduleRoot, 'Vendor')}`,
      `-I${join(moduleRoot, 'Vendor/highlights')}`, `-I${join(moduleRoot, 'Vendor/wasm2c')}`,
      join(root, 'tests/fixtures/solus-highlights-harness.c'),
      join(moduleRoot, 'cpp/solus_highlights.c'),
      join(moduleRoot, 'Vendor/highlights/highlights.c'),
      join(moduleRoot, 'Vendor/wasm2c/wasm-rt-impl.c'),
      join(moduleRoot, 'Vendor/wasm2c/wasm-rt-mem-impl.c'),
      '-o', executable,
    ], { timeout: 120_000 })
  }, 150_000)

  afterAll(() => {
    if (directory) rmSync(directory, { recursive: true, force: true })
  })

  test('returns the WebAssembly build\'s records for every lexer', () => {
    const cases = buildCases()
    const input = join(directory, 'cases.bin')
    const output = join(directory, 'records.bin')
    const header = new DataView(new ArrayBuffer(5))
    const chunks: Uint8Array[] = []
    for (const highlightCase of cases) {
      header.setUint8(0, highlightCase.language)
      header.setUint32(1, highlightCase.source.length, true)
      chunks.push(new Uint8Array(header.buffer.slice(0)), highlightCase.source)
    }
    writeFileSync(input, Buffer.concat(chunks))
    // Bun's child_process drops this child's stdout, so the records go to a file.
    const run = spawnSync(executable, [input, output], { timeout: 60_000 })
    expect({ status: run.status, signal: run.signal }).toEqual({ status: 0, signal: null })

    const native = readFileSync(output)
    const wasm = createHighlighter() as unknown as LineRecordHighlighter
    let offset = 0
    const mismatches: string[] = []
    for (const highlightCase of cases) {
      const count = Number(native.readBigInt64LE(offset))
      offset += 8
      const nativeRecords = new Uint32Array(native.buffer.slice(native.byteOffset + offset, native.byteOffset + offset + count * 4))
      offset += count * 4
      const wasmRecords = wasm.tokenizeLineRecords(highlightCase.language, wasm.writeInput(highlightCase.source))
      if (count < 0 || !Buffer.from(nativeRecords.buffer).equals(Buffer.from(wasmRecords.buffer, wasmRecords.byteOffset, wasmRecords.byteLength))) {
        mismatches.push(highlightCase.name)
      }
    }
    expect(offset).toBe(native.length)
    expect(cases.length).toBeGreaterThan(80 * 10)
    expect(mismatches).toEqual([])
  }, 120_000)
})
