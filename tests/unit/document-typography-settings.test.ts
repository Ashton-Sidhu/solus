import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'

const readSource = (path: string) =>
  readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8')

describe('document typography settings', () => {
  test('old settings keep the current Solus document preset', () => {
    // WHY: adding preferences must not silently restyle existing documents or
    // plans when the saved settings blob does not contain the new fields.
    const settings = readSource(
      'packages/workspace-ui/src/contexts/app/settings.context.svelte.ts',
    )

    expect(settings).toContain("documentFontFamily: z.enum(")
    expect(settings).toContain(".catch('solus')")
    expect(settings).toContain('documentFontSize: z.number().min(12).catch(DEFAULT_DOCUMENT_FONT_SIZE)')
    expect(settings).toContain('const DEFAULT_DOCUMENT_FONT_SIZE = 16')
  })

  test('the shared document shell applies the preferences to documents and plans', () => {
    // WHY: PlanModal uses DocumentShell, so one scoped CSS contract must drive
    // both editors instead of allowing their typography to drift.
    const css = readSource('packages/workspace-ui/src/index.css')
    const plan = readSource('packages/workspace-ui/src/components/plan/PlanModal.svelte')

    expect(plan).toContain('<DocumentShell')
    expect(css).toContain('--solus-font-scale: var(--solus-document-font-scale)')
    expect(css).toContain('--text-body: calc(1rem * var(--solus-document-font-scale))')
    expect(css).toContain('--text-h1: calc(1.9375rem * var(--solus-document-font-scale))')
    expect(css).toContain('font-family: var(--solus-document-font-family)')
    expect(css).toContain('--solus-doc-serif: var(--solus-document-heading-font-family)')
  })

  test('settings exposes keyboard-accessible font and size controls', () => {
    // WHY: the preference must be available on every client through the shared
    // Settings surface, with explicit labels for keyboard and screen-reader use.
    const general = readSource(
      'packages/workspace-ui/src/components/settings/SettingsTabGeneral.svelte',
    )

    expect(general).toContain('aria-label="Document font"')
    expect(general).toContain('aria-label="Decrease document size"')
    expect(general).toContain('aria-label="Document size in pixels"')
    expect(general).toContain('aria-label="Increase document size"')
  })
})
