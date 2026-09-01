import { describe, expect, test } from 'bun:test'
import { importDocCopy } from '@solus/workspace-ui/components/work/lib/import-doc'
import { docProviderLogo } from '@solus/workspace-ui/components/work/lib/work-publish'

describe('import dialog copy', () => {
  test('a named provider is named, and shows the link shape it wants', () => {
    expect(importDocCopy('confluence').title).toBe('Import from Confluence')
    expect(importDocCopy('confluence').placeholder).toContain('atlassian.net')
    expect(importDocCopy('gdrive').title).toBe('Import from Google Drive')
    expect(importDocCopy('gdrive').placeholder).toContain('docs.google.com')
  })

  test('without a provider the dialog stays open to both', () => {
    // The command palette reaches it this way, with no provider chosen.
    expect(importDocCopy().title).toBe('Import a document')
    expect(importDocCopy().description).toContain('Confluence')
    expect(importDocCopy().description).toContain('Google Drive')
  })
})

describe('document provider logos', () => {
  test('uses the upstream product logo instead of a generic cloud mark', () => {
    expect(docProviderLogo('gdrive')).toBe('logos:google-drive')
    expect(docProviderLogo('confluence')).toBe('logos:confluence')
  })
})
