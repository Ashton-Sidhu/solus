import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import {
  cliTransformOptions,
  compareCoverage,
  configuredCompiler,
  consistencyProblems,
  describeChange,
  lowersCoverage,
  nativeSources,
  readBaseline,
  runCoverage,
  summarize,
  toolchainVersions,
  unacceptedReductions,
  type CoverageBaseline,
} from '../../scripts/check-mobile-compiler-coverage'
import { coverFile, mobileToolchain, type FileCoverage } from '../../scripts/lib/mobile-compiler-transform'

const root = resolve(import.meta.dir, '../..')

// The guard: the compiler-enabled build of every native module, through the
// installed Expo transformer, against the reviewed baseline. When it fails,
// `bun scripts/check-mobile-compiler-coverage.ts --list` shows each skip and
// its diagnostics (docs/plans/mobile-compiler-coverage.md).
describe('mobile compiler coverage', () => {
  test('every component and hook the compiler attempts keeps its reviewed outcome', async () => {
    const files = await runCoverage({ root, paths: nativeSources(root), mode: 'enabled', semantics: false, allPlatforms: false })
    expect(consistencyProblems(files, true)).toEqual([])
    expect(compareCoverage(summarize(files), toolchainVersions(root), readBaseline(root)).map(describeChange)).toEqual([])
  }, 25_000)

  test('the shared packages bundled into the app hold no React code for the compiler to attempt', () => {
    // Metro compiles @solus/contracts and @solus/client-core from source with
    // the app's Babel config. A component or hook there would need coverage.
    const reactImports = ['packages/client-core/src', 'packages/contracts/src'].flatMap((folder) =>
      readdirSync(join(root, folder), { recursive: true, encoding: 'utf8' })
        .filter((path) => /\.tsx?$/.test(path))
        .filter((path) => /from ['"]react['"]/.test(readFileSync(join(root, folder, path), 'utf8')))
        .map((path) => `${folder}/${path}`))
    expect(reactImports).toEqual([])
  })

  test('the native release build turns the React Compiler on through the Expo flag', () => {
    // `expo.experiments.reactCompiler` in app.json; babel.config.js stays the
    // plain Expo preset, which adds the compiler plugin once.
    expect(configuredCompiler(root)).toBe(true)
    const options = cliTransformOptions(root, 'ios', 'configured')
    expect(options.customTransformOptions.reactCompiler).toBe('true')
    const path = 'apps/mobile/src/features/files/SourceFileSurface.tsx'
    const file = coverFile(mobileToolchain(root), { root, path, platform: 'ios', options, withoutCompiler: null })
    expect(file.compilerPlugin).toBe(true)
    expect(file.memoCacheCalls).toBeGreaterThan(0)
  })
})

// The harness itself, on fixture modules in a temporary copy of the app's
// Babel and Expo config. The installed toolchain is linked, not copied.
describe('the coverage harness', () => {
  let fixtureRoot = ''
  const fixture = (name: string, source: string): string => {
    const path = `apps/mobile/src/${name}`
    writeFileSync(join(fixtureRoot, path), source)
    return path
  }
  const cover = (path: string): FileCoverage => coverFile(mobileToolchain(fixtureRoot), {
    root: fixtureRoot,
    path,
    platform: 'ios',
    options: cliTransformOptions(fixtureRoot, 'ios', 'enabled'),
    withoutCompiler: cliTransformOptions(fixtureRoot, 'ios', 'disabled'),
  })

  beforeAll(() => {
    fixtureRoot = mkdtempSync(join(tmpdir(), 'solus-compiler-coverage-'))
    mkdirSync(join(fixtureRoot, 'apps/mobile/src'), { recursive: true })
    for (const file of ['babel.config.js', 'app.json', 'package.json']) {
      copyFileSync(join(root, 'apps/mobile', file), join(fixtureRoot, 'apps/mobile', file))
    }
    symlinkSync(join(root, 'node_modules'), join(fixtureRoot, 'node_modules'))
    symlinkSync(join(root, 'apps/mobile/node_modules'), join(fixtureRoot, 'apps/mobile/node_modules'))
  })
  afterAll(() => rmSync(fixtureRoot, { recursive: true, force: true }))

  test('names each attempted function and why the compiler left it alone', () => {
    const file = cover(fixture('Outcomes.tsx', `import { memo, useRef, useState } from 'react'
import { Text } from 'react-native'
import Animated, { useAnimatedStyle, useSharedValue } from 'react-native-reanimated'

export function Counter() {
  const [count] = useState(0)
  return <Text>{count}</Text>
}

export const Label = memo((props: { text: string }) => {
  const renders = useRef(0)
  renders.current += 1
  return <Text>{props.text}</Text>
})

export function OptedOut() {
  'use no memo'
  const [count] = useState(0)
  return <Text>{count}</Text>
}

export function Fade() {
  const opacity = useSharedValue(0)
  const style = useAnimatedStyle(() => ({ opacity: opacity.value }))
  return <Animated.View style={style} />
}
`))
    expect(file.functions.map((fn) => [fn.name, fn.compiled, fn.reasons])).toEqual([
      ['Counter', true, []],
      ['Label', false, ['Refs']],
      ['OptedOut', false, ['OptOut']],
      ['Fade', true, []],
    ])
    expect(consistencyProblems([file], true)).toEqual([])
    // The logger observes the real transform without changing it, and the
    // compiled module keeps its interface and maps back to its source lines.
    expect(file.semantics?.observerPassive).toBe(true)
    expect(file.semantics?.interfaceWithCompiler).toEqual(file.semantics?.interfaceWithoutCompiler)
    expect(file.semantics?.sourceMap).toEqual({ located: 2, mapped: 2, misses: [] })
  })

  test('a module-level opt-out cannot pass as compiled coverage', () => {
    // The compiler still reports success for each function, then emits nothing.
    const file = cover(fixture('Silent.tsx', `'use no memo'
import { useState } from 'react'
import { Text } from 'react-native'

export function Silent() {
  const [count] = useState(0)
  return <Text>{count}</Text>
}
`))
    expect(file.functions.map((fn) => [fn.name, fn.compiled])).toEqual([['Silent', true]])
    expect(consistencyProblems([file], true)).toEqual([
      'apps/mobile/src/Silent.tsx (ios): 1 compiled functions use memo slots, but the module has 0 memo caches',
    ])
  })

  test('the app config flag alone turns the compiler on for the release build', () => {
    const appJson = join(fixtureRoot, 'apps/mobile/app.json')
    const config: { expo: { experiments?: { reactCompiler?: boolean } } } = JSON.parse(readFileSync(appJson, 'utf8'))
    writeFileSync(appJson, JSON.stringify({ expo: { ...config.expo, experiments: { ...config.expo.experiments, reactCompiler: true } } }))
    expect(configuredCompiler(fixtureRoot)).toBe(true)
    expect(cliTransformOptions(fixtureRoot, 'ios', 'configured').customTransformOptions.reactCompiler).toBe('true')
    expect(cliTransformOptions(fixtureRoot, 'android', 'disabled').customTransformOptions.reactCompiler).toBeUndefined()
  })
})

// The ratchet: known skips only shrink by themselves, and any loss of
// coverage must be named when the baseline is written.
describe('the coverage baseline', () => {
  const toolchain = { 'babel-plugin-react-compiler': '1.0.0' }
  const baseline: CoverageBaseline = {
    toolchain,
    files: { 'apps/mobile/src/A.tsx': { compiled: ['Row', 'useRows'], skipped: [{ name: 'List', reasons: ['Refs'] }] } },
  }
  const compare = (compiled: string[], skipped: CoverageBaseline['files'][string]['skipped']): string[] =>
    compareCoverage({ 'apps/mobile/src/A.tsx': { compiled, skipped } }, toolchain, baseline).map((change) => change.kind)

  test('a function that stops compiling lowers coverage and must be accepted by name', () => {
    const changes = compareCoverage({
      'apps/mobile/src/A.tsx': { compiled: ['useRows'], skipped: [{ name: 'List', reasons: ['Refs'] }, { name: 'Row', reasons: ['Todo'] }] },
    }, toolchain, baseline)
    expect(changes.map((change) => change.kind)).toEqual(['new-skip'])
    expect(changes.every(lowersCoverage)).toBe(true)
    expect(unacceptedReductions(changes, [])).toHaveLength(1)
    expect(unacceptedReductions(changes, ['apps/mobile/src/A.tsx#Row'])).toEqual([])
    expect(unacceptedReductions(changes, ['apps/mobile/src/'])).toEqual([])
    expect(unacceptedReductions(changes, ['apps/mobile/src/A.tsx#List'])).toHaveLength(1)
  })

  test('a known skip that compiles again fails the check until the baseline drops it', () => {
    const kinds = compare(['List', 'Row', 'useRows'], [])
    expect(kinds).toEqual(['fixed-skip'])
    expect(compareCoverage({ 'apps/mobile/src/A.tsx': { compiled: ['List', 'Row', 'useRows'], skipped: [] } }, toolchain, baseline)
      .some(lowersCoverage)).toBe(false)
  })

  test('a compiled function that disappears is a loss, not a silent change', () => {
    expect(compare(['useRows'], [{ name: 'List', reasons: ['Refs'] }])).toEqual(['lost-compile'])
    expect(compare(['Row', 'RowItem', 'useRows'], [{ name: 'List', reasons: ['Refs'] }])).toEqual(['new-compile'])
    expect(compare(['Row', 'useRows'], [])).toEqual(['gone-skip'])
  })

  test('a skip with a different cause, or a different toolchain, is reported', () => {
    expect(compare(['Row', 'useRows'], [{ name: 'List', reasons: ['PreserveManualMemo'] }])).toEqual(['skip-reasons'])
    const changes = compareCoverage(summarize([]), { 'babel-plugin-react-compiler': '1.1.0' }, { toolchain, files: {} })
    expect(changes.map(describeChange)).toEqual(['babel-plugin-react-compiler is 1.1.0; the baseline was measured with 1.0.0'])
  })
})
