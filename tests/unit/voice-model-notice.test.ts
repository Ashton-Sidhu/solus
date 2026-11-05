import { expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { compile } from 'svelte/compiler'
import { render } from 'svelte/server'

test('model preparation is visible without hovering and disappears when ready', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'solus-voice-notice-'))
  const root = new URL('../../', import.meta.url)
  try {
    const hostsPath = join(directory, 'hosts.mjs')
    writeFileSync(hostsPath, `export const hosts = { transcription: {
      capabilityRecord: { voiceModel: true }, voiceStatus: { state: 'checking' },
      voiceProgressPct: null, retryVoiceModel() {},
    } }; export function requestInputFocus() {}`)
    const hostsUrl = pathToFileURL(hostsPath).href
    const source = readFileSync(new URL('packages/workspace-ui/src/components/input/VoiceModelNotice.svelte', root), 'utf8')
    // Both renderer compilation and the rendered copy must remain valid.
    expect(compile(source, { generate: 'client' }).warnings).toEqual([])
    const compiled = compile(source, { generate: 'server' }).js.code
      .replaceAll(/(['"])svelte\/internal\/server\1/g, JSON.stringify(new URL('node_modules/svelte/src/internal/server/index.js', root).href))
      .replaceAll('"../../contexts/hosts/hosts.svelte"', JSON.stringify(hostsUrl))
      .replaceAll('"../../lib/inputFocus"', JSON.stringify(hostsUrl))
    const componentPath = join(directory, 'notice.mjs')
    writeFileSync(componentPath, compiled)
    const { hosts } = await import(hostsUrl)
    const host = hosts.transcription
    const componentUrl = pathToFileURL(componentPath).href
    const { default: Notice } = await import(componentUrl)
    const html = () => render(Notice).body

    expect(html()).not.toContain('role="status"')
    host.voiceStatus = { state: 'downloading' }
    expect(html()).toContain('Downloading voice model')
    expect(html()).toContain('You can keep typing.')
    expect(html()).not.toContain('<progress') // No guessed percentage before the size arrives.
    host.voiceProgressPct = 42
    expect(html()).toContain('value="42"')
    expect(html()).toContain('42%')

    host.voiceStatus = { state: 'installing' }
    expect(html()).toContain('Installing voice model')
    expect(html()).not.toContain('<progress')
    host.voiceStatus = { state: 'error', error: 'Download failed' }
    expect(html()).toContain('Voice model download failed.')
    expect(html()).toContain('Retry voice model download')
    host.voiceStatus = { state: 'ready' }
    expect(html()).not.toContain('role="status"')

    // Unsupported hosts and an absent transcription host must not report a download.
    host.voiceStatus = { state: 'error' }
    host.capabilityRecord = { voiceModel: false }
    expect(html()).not.toContain('role="status"')
    hosts.transcription = null
    expect(html()).not.toContain('role="status"')
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
