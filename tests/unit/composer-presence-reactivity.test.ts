import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { compileModule } from 'svelte/compiler'
import { effect_root } from 'svelte/internal/client'

test('session metadata cannot stop typing; clearing, hiding, and changing rooms can', async () => {
  const runes = ['$state', '$effect', '$derived', '$inspect', '$props', '$bindable']
  const descriptors = runes.map((name) => {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, name)
    try { Reflect.get(globalThis, name); return [name, descriptor] as const }
    catch { return [name, undefined] as const }
  })
  const source = readFileSync(new URL('../../packages/workspace-ui/src/components/input/InputBar.svelte', import.meta.url), 'utf8')
  const effect = source.slice(source.indexOf('  const typingServerId'), source.indexOf('  function handlePromptChange'))
  const compiled = compileModule(`
    import { untrack } from 'svelte';
    export function install(initial, presenceStore) {
      let sess = $state(initial);
      let active = $state(true);
      let editorHasText = $state(true);
      ${effect}
      return {
        session(value) { sess = value; },
        visible(value) { active = value; },
        text(value) { editorHasText = value; },
      };
    }
  `, { filename: 'composer-presence.svelte.js', generate: 'client' }).js.code
  const code = compiled.replace(/from (["'])([^"']+)\1/g, (_match, _quote, name: string) => `from ${JSON.stringify(Bun.resolveSync(name === 'svelte' ? 'svelte/internal/client' : name, import.meta.dir))}`)
  const module = await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`)
  const stops: string[] = []
  const initial = { id: 'session', run: { serverId: 'host' }, title: 'Before' }
  let controls!: { session(value: typeof initial): void; visible(value: boolean): void; text(value: boolean): void }
  const stop = effect_root(() => {
    controls = module.install(initial, { stopTyping: (host: string, session: string) => { stops.push(`${host}:${session}`) } })
  })
  try {
    await Promise.resolve()
    controls.session({ ...initial, title: 'After' })
    await Promise.resolve()
    expect(stops).toEqual([])
    controls.text(false)
    await Promise.resolve()
    expect(stops).toEqual(['host:session'])
    controls.text(true)
    await Promise.resolve()
    controls.visible(false)
    await Promise.resolve()
    expect(stops).toEqual(['host:session', 'host:session'])
    controls.visible(true)
    await Promise.resolve()
    controls.session({ ...initial, id: 'other' })
    await Promise.resolve()
    expect(stops).toEqual(['host:session', 'host:session', 'host:session'])
  } finally {
    stop()
    // The compiled client runtime installs development rune getters globally.
    // Restore the test process so plain store fixtures can install their runes.
    for (const [name, descriptor] of descriptors) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor)
      else Reflect.deleteProperty(globalThis, name)
    }
  }
  expect(stops.at(-1)).toBe('host:other')
})
