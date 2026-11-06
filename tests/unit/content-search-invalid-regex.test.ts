import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { searchProjectContents } from '@solus/server/files/content-search'

const request = { useRegex: true, wholeWord: false }

/**
 * A person types a regex one character at a time, so `foo(` is an ordinary
 * state. It finds its text as a literal, with the error shown beside the
 * results, whether or not Match case is on.
 */
describe('project search with an invalid regex', () => {
  const roots: string[] = []
  afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

  test('searches the text literally and ignores case when Match case is off', async () => {
    const root = mkdtempSync(join(tmpdir(), 'solus-content-search-'))
    roots.push(root)
    writeFileSync(join(root, 'calls.ts'), 'call(Foo(bar));\n')

    const result = await searchProjectContents(root, { ...request, query: 'foo(', caseSensitive: false })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.regexError).toBeDefined()
    expect(result.matches.map((match) => match.lineContent)).toEqual(['call(Foo(bar));'])
  })

  test('keeps case when Match case is on', async () => {
    const root = mkdtempSync(join(tmpdir(), 'solus-content-search-'))
    roots.push(root)
    writeFileSync(join(root, 'calls.ts'), 'call(Foo(bar));\n')

    const result = await searchProjectContents(root, { ...request, query: 'foo(', caseSensitive: true })

    expect(result.ok && result.matches).toEqual([])
  })
})
