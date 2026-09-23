import { describe, expect, test } from 'bun:test'
import { cssFontFamilies, customFamilyStack } from '@solus/workspace-ui/lib/font-family'

// A font preference can be a family name typed by the user or read off the
// machine's font list. It reaches CSS as free text, so it is quoted here.
describe('cssFontFamilies', () => {
  test('a name with spaces is quoted so the declaration stays valid', () => {
    expect(cssFontFamilies('Berkeley Mono')).toBe('"Berkeley Mono"')
  })

  test('a single ident and an already-quoted name pass through', () => {
    expect(cssFontFamilies('Menlo')).toBe('Menlo')
    expect(cssFontFamilies("'SF Mono'")).toBe("'SF Mono'")
  })

  test('a stray double quote cannot close the string early', () => {
    expect(cssFontFamilies('Foo" Bar')).toBe('"Foo Bar"')
  })

  test('a comma list is quoted per family and blanks are dropped', () => {
    expect(cssFontFamilies('Berkeley Mono, , Menlo')).toBe('"Berkeley Mono", Menlo')
  })

  test('empty input is null so callers fall back cleanly', () => {
    expect(cssFontFamilies('  ,  ')).toBeNull()
  })
})

describe('customFamilyStack', () => {
  test('the family leads and the default stack stays behind it for glyph coverage', () => {
    expect(customFamilyStack('Berkeley Mono', "'JetBrains Mono', monospace")).toBe(
      '"Berkeley Mono", \'JetBrains Mono\', monospace',
    )
  })

  test('an empty family is the default stack alone', () => {
    expect(customFamilyStack('', "'Inter', sans-serif")).toBe("'Inter', sans-serif")
  })
})
