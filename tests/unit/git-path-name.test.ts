import { describe, expect, test } from 'bun:test'
import { decodeGitPath, quoteGitPath } from '@solus/client-core/git-path-name'

// Git quotes a path with special characters in a patch header. Every client
// must show and match the real path, which is what the host sends.
describe('decodeGitPath', () => {
  test('keeps a plain name', () => {
    expect(decodeGitPath('src/app.ts')).toBe('src/app.ts')
  })

  test('keeps a name with spaces, which git does not quote', () => {
    expect(decodeGitPath('docs/read me.md')).toBe('docs/read me.md')
  })

  test('decodes octal bytes as UTF-8', () => {
    expect(decodeGitPath('caf\\303\\251 menu.ts')).toBe('café menu.ts')
    expect(decodeGitPath('\\346\\227\\245\\346\\234\\254.md')).toBe('日本.md')
  })

  test('decodes the C escapes for tab, newline, quote, and backslash', () => {
    expect(decodeGitPath('a\\tb\\nc')).toBe('a\tb\nc')
    expect(decodeGitPath('say \\"hi\\".ts')).toBe('say "hi".ts')
    expect(decodeGitPath('dir\\\\file.ts')).toBe('dir\\file.ts')
  })

  test('removes the quotes of a rename source', () => {
    // `rename from "caf\303\251.ts"` keeps its quotes in the parser's prevName.
    expect(decodeGitPath('"caf\\303\\251.ts"')).toBe('café.ts')
  })
})

describe('quoteGitPath', () => {
  test('keeps a path that needs no quotes, also non-ASCII text', () => {
    expect(quoteGitPath('a/café menu.ts')).toBe('a/café menu.ts')
  })

  test('quotes a path that decodeGitPath would change, and gives it back the same', () => {
    for (const path of ['a/dir\\file.ts', 'a/say "hi".ts', 'a/tab\there.ts', 'a/bell\u0007.ts']) {
      const quoted = quoteGitPath(path)
      expect(quoted.startsWith('"')).toBe(true)
      expect(decodeGitPath(quoted)).toBe(path)
    }
  })
})
