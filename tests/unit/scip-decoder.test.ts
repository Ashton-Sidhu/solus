import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'fs'
import { join } from 'path'
import {
  decodeScipIndex,
  SCIP_ROLE_DEFINITION,
} from '@solus/server/code-intel/scip-decoder'
import { symbolDisplayName } from '@solus/server/code-intel/symbol-name'

/**
 * The decoder reads real indexer output, not a shape Solus invented. The
 * fixture is `scip-typescript index` over tests/unit/__fixtures__/scip/
 * typescript-project, so a decoder that drifts from the protobuf schema fails
 * here before it fails on a user's repository.
 */

const FIXTURE_ROOT = join(import.meta.dir, '__fixtures__', 'scip', 'typescript-project')

function loadFixture() {
  return decodeScipIndex(new Uint8Array(readFileSync(join(FIXTURE_ROOT, 'index.scip'))))
}

describe('decodeScipIndex', () => {
  test('reads metadata and one document per source file', () => {
    const index = loadFixture()
    expect(index.toolName).toBe('scip-typescript')
    expect(index.projectRoot.startsWith('file://')).toBe(true)
    expect(index.documents.map((document) => document.relativePath).sort()).toEqual([
      'src/main.ts',
      'src/math.ts',
    ])
  })

  test('maps the definition of `add` to its exact source range', () => {
    const math = loadFixture().documents.find((document) => document.relativePath === 'src/math.ts')!
    const source = readFileSync(join(FIXTURE_ROOT, 'src/math.ts'), 'utf-8').split('\n')
    const definition = math.occurrences.find(
      (occurrence) =>
        occurrence.symbol.endsWith('/add().') && (occurrence.symbolRoles & SCIP_ROLE_DEFINITION) !== 0,
    )!
    expect(definition).toBeDefined()
    const { startLine, startCharacter, endLine, endCharacter } = definition.range
    expect(startLine).toBe(endLine)
    expect(source[startLine]!.slice(startCharacter, endCharacter)).toBe('add')
  })

  test('keeps the doc comment on the symbol so hover can show it', () => {
    const math = loadFixture().documents.find((document) => document.relativePath === 'src/math.ts')!
    const info = math.symbols.find((symbol) => symbol.symbol.endsWith('/add().'))!
    expect(info.documentation.join('\n')).toContain('Adds two numbers')
  })

  test('sees the cross-file reference from main.ts back to add', () => {
    const main = loadFixture().documents.find((document) => document.relativePath === 'src/main.ts')!
    const references = main.occurrences.filter(
      (occurrence) =>
        occurrence.symbol.endsWith('/add().') && (occurrence.symbolRoles & SCIP_ROLE_DEFINITION) === 0,
    )
    expect(references.length).toBeGreaterThanOrEqual(1)
  })
})

describe('symbolDisplayName', () => {
  test('reads the last descriptor of each symbol shape', () => {
    const prefix = 'scip-typescript npm scip-fixture 1.0.0 '
    expect(symbolDisplayName(`${prefix}src/\`math.ts\`/add().`)).toBe('add')
    expect(symbolDisplayName(`${prefix}src/\`math.ts\`/Counter#increment().`)).toBe('increment')
    expect(symbolDisplayName(`${prefix}src/\`math.ts\`/Counter#`)).toBe('Counter')
    expect(symbolDisplayName(`${prefix}src/\`math.ts\`/add().(a)`)).toBe('a')
    expect(symbolDisplayName(`${prefix}src/\`math.ts\`/map()[T]`)).toBe('T')
    expect(symbolDisplayName(`${prefix}src/\`math.ts\`/`)).toBe('math.ts')
    expect(symbolDisplayName('local 3')).toBe('')
  })
})
