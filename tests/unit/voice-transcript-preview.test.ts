import { expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { compile } from 'svelte/compiler'
import { render } from 'svelte/server'

test('live text renders complete snapshots, separates tentative words, and escapes model output', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'solus-voice-preview-'))
  const root = new URL('../../', import.meta.url)
  try {
    const source = readFileSync(new URL('packages/workspace-ui/src/components/input/VoiceTranscriptPreview.svelte', root), 'utf8')
    expect(compile(source, { generate: 'client' }).warnings).toEqual([])
    const code = compile(source, { generate: 'server' }).js.code
      .replaceAll(/(['"])svelte\/internal\/server\1/g, JSON.stringify(new URL('node_modules/svelte/src/internal/server/index.js', root).href))
    const path = join(directory, 'preview.mjs')
    writeFileSync(path, code)
    const componentUrl = pathToFileURL(path).href
    const { default: Preview } = await import(componentUrl)
    const partial = { stable: 'Open the ', tentative: 'cat' }
    const initial = render(Preview, { props: { partial } }).body
    expect(initial).toContain('<span>Open the </span><span class="text-(--solus-text-tertiary)">cat</span>')
    const revised = render(Preview, { props: { partial: { ...partial, tentative: 'calendar' } } }).body
    expect(revised).toContain('>calendar</span>')
    expect(revised).not.toContain('>cat</span>')
    const escaped = render(Preview, { props: { partial: { stable: '<script>', tentative: '<img>' }, compact: true } }).body
    expect(escaped).toContain('&lt;script>')
    expect(escaped).toContain('&lt;img>')
    expect(escaped).not.toContain('<script>')
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
