import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { compile } from 'svelte/compiler'
import * as client from 'svelte/internal/client'

test('mounting a terminal logo does not resolve terminals or guess the active application', async () => {
  const descriptors = ['$state', '$effect', '$derived', '$inspect', '$props', '$bindable'].map((name) => {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, name)
    try { Reflect.get(globalThis, name); return [name, descriptor] as const }
    catch { return [name, undefined] as const }
  })
  const source = readFileSync(new URL('../../packages/workspace-ui/src/components/settings/TerminalAppLogo.svelte', import.meta.url), 'utf8')
  let reads = 0
  let application: string | null | undefined
  const toolsStore = { resolvedTerminal: null, refreshResolvedTerminal() { reads++; return Promise.resolve(null) } }
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
    expect(application).toBeNull()
  } finally {
    stop()
    for (const [name, descriptor] of descriptors) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor)
      else Reflect.deleteProperty(globalThis, name)
    }
  }
})
