import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { compile } from 'svelte/compiler'
import * as client from 'svelte/internal/client'
import type { ResolvedTerminal } from '@solus/contracts/types'

test.each([
  { label: 'configured terminal before inspection', resolved: null, expected: 'ghostty' },
  { label: 'known attached terminal after inspection', resolved: { id: 'wezterm', name: 'WezTerm', source: 'attached' }, expected: 'wezterm' },
  { label: 'unknown attached terminal without using the configured icon', resolved: { id: null, name: 'Warp', source: 'attached' }, expected: null },
] satisfies { label: string; resolved: ResolvedTerminal | null; expected: string | null }[])('shows $label without starting a terminal read', async ({ resolved, expected }) => {
  const descriptors = ['$state', '$effect', '$derived', '$inspect', '$props', '$bindable'].map((name) => {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, name)
    try { Reflect.get(globalThis, name); return [name, descriptor] as const }
    catch { return [name, undefined] as const }
  })
  const source = readFileSync(new URL('../../packages/workspace-ui/src/components/settings/TerminalAppLogo.svelte', import.meta.url), 'utf8')
  let reads = 0
  let application: string | null | undefined
  const toolsStore = { resolvedTerminal: resolved, refreshResolvedTerminal() { reads++; return Promise.resolve(null) } }
  const compiled = compile(source, { filename: 'TerminalAppLogo.svelte', generate: 'client' }).js.code
    .replace(/^import .*;$/gm, '').replace('export default function', 'function')
  const component = new Function('$', 'toolsStore', 'getSettingsContext', 'AppLogo', compiled + '\nreturn TerminalAppLogo;')(
    client, toolsStore, () => ({ fallbackTerminal: 'ghostty' }),
    (_anchor: null, props: { id: string | null }) => { application = props.id },
  )
  const stop = client.effect_root(() => component(null, {}))
  try {
    await Promise.resolve()
    expect(reads).toBe(0)
    expect(application).toBe(expected)
  } finally {
    stop()
    for (const [name, descriptor] of descriptors) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor)
      else Reflect.deleteProperty(globalThis, name)
    }
  }
})
