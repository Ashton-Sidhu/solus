/// <reference types="bun-types" />
/**
 * Guards the three ways a Solus design token can be defined correctly and still
 * never reach the DOM. All three have shipped: menu rows with no font-size,
 * popovers wearing Tailwind's generic shadow, dropdowns with no shadow at all.
 * None of them produce a build error, so only a test catches them.
 *
 * Run with `bun run test:unit`.
 */
import { describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import { Glob } from 'bun'
import { cn } from '@solus/workspace-ui/lib/utils'

const RENDERER = join(import.meta.dir, '../../packages/workspace-ui/src')
const indexCss = await Bun.file(join(RENDERER, 'index.css')).text()

/** Body of every `@theme`/`@utility` block, brace-matched so nested `@keyframes` don't end it early. */
function blocks(source: string, opener: RegExp): string[] {
  const out: string[] = []
  for (const match of source.matchAll(opener)) {
    let depth = 1
    let i = match.index + match[0].length
    const start = i
    while (i < source.length && depth > 0) {
      if (source[i] === '{') depth++
      else if (source[i] === '}') depth--
      i++
    }
    out.push(source.slice(start, i - 1))
  }
  return out
}

/** Custom-property declarations at the top level of a block (skips `@keyframes` innards). */
function topLevelKeys(block: string): string[] {
  const keys: string[] = []
  let depth = 0
  for (const line of block.split('\n')) {
    if (depth === 0) {
      const key = line.match(/^\s*(--[a-z0-9-]+)\s*:/)
      if (key) keys.push(key[1])
    }
    depth += (line.match(/\{/g)?.length ?? 0) - (line.match(/\}/g)?.length ?? 0)
  }
  return keys
}

// ─── Mechanism 1: tailwind-merge silently drops custom `@theme` utilities ────

/**
 * A custom `@theme` key is only at risk when the utility prefix it generates is
 * shared with another property group — tailwind-merge guesses the group, and a
 * wrong guess means the class is deleted against a same-prefix neighbour. Each
 * risky namespace names the neighbour that must *not* be able to evict it.
 *
 * A namespace missing from this table fails the test rather than passing by
 * default: adding `--tracking-menu` or `--leading-menu` should force whoever
 * adds it to decide whether `lib/tw.ts` needs to know about it.
 */
const NAMESPACES: Record<string, { utility: (name: string) => string; companion: string } | 'safe'> = {
  // `text-` is font-size *and* text-colour.
  text: { utility: (name) => `text-${name}`, companion: 'text-(--solus-text-secondary)' },
  // `font-` is font-weight *and* font-family.
  'font-weight': { utility: (name) => `font-${name}`, companion: 'font-mono' },
  // An unknown word after a colour prefix is exactly what tailwind-merge assumes.
  color: 'safe',
  // Stock scale names; tailwind-merge already knows them.
  radius: 'safe',
  // `animate-` belongs to one group, so nothing else can claim the class.
  animate: 'safe',
}

const allThemeKeys = blocks(indexCss, /@theme[^{]*\{/g).flatMap(topLevelKeys)

/** Tailwind v4 reads `--text-body--line-height` as a *modifier* on `--text-body`,
 *  not as a key of its own: it emits no `text-body--line-height` utility, so
 *  there is nothing for tailwind-merge to drop. Modifiers are checked by the
 *  parent-key test below instead of being run through cn(). */
const MODIFIER_SUFFIXES = ['--line-height', '--letter-spacing', '--font-weight']
const isModifier = (key: string) => MODIFIER_SUFFIXES.some((suffix) => key.endsWith(suffix))
const themeKeys = allThemeKeys.filter((key) => !isModifier(key))

describe('custom @theme keys survive cn()', () => {
  test('index.css actually parses (guards the parser, not the CSS)', () => {
    expect(themeKeys).toContain('--text-menu')
    expect(themeKeys).toContain('--font-weight-secondary')
  })

  test('every modifier hangs off a key that exists', () => {
    // WHY: a modifier whose parent is missing or misspelled is silently inert —
    // the rung renders at Tailwind's default leading and nothing reports it.
    for (const key of allThemeKeys.filter(isModifier)) {
      const suffix = MODIFIER_SUFFIXES.find((candidate) => key.endsWith(candidate))!
      expect(themeKeys, `${key} has no parent key in @theme`).toContain(
        key.slice(0, -suffix.length),
      )
    }
  })

  for (const key of [...new Set(themeKeys)]) {
    const namespace = Object.keys(NAMESPACES)
      .sort((a, b) => b.length - a.length)
      .find((ns) => key.startsWith(`--${ns}-`))

    test(`${key}`, () => {
      expect(
        namespace,
        `${key} is in a @theme namespace this test has never seen. Decide whether its ` +
          `utility prefix is shared with another property group — if it is, register the ` +
          `class in twMergeConfig in lib/tw.ts — then add the namespace to NAMESPACES here.`,
      ).toBeDefined()

      const spec = NAMESPACES[namespace!]
      if (spec === 'safe') return

      const utility = spec.utility(key.slice(`--${namespace}-`.length))
      for (const list of [`${utility} ${spec.companion}`, `${spec.companion} ${utility}`]) {
        expect(
          cn(list).split(' '),
          `cn("${list}") dropped ${utility}. Register it in twMergeConfig in lib/tw.ts.`,
        ).toContain(utility)
      }
    })
  }
})

// ─── Mechanism 2: ambiguous arbitrary values never override stock classes ────

describe('arbitrary shadows override the stock shadow they are meant to replace', () => {
  test('the `shadow:` type hint removes shadow-md', () => {
    const merged = cn('menu-surface ring-0 shadow-md shadow-[shadow:var(--solus-menu-shadow)]').split(' ')
    expect(merged).toContain('shadow-[shadow:var(--solus-menu-shadow)]')
    expect(merged).not.toContain('shadow-md')
  })

  test('the bare form does not — this is why the hint is load-bearing', () => {
    // `shadow-[var(…)]` is ambiguous, so tailwind-merge files it under
    // shadow-*colour* and lets shadow-md stand. Both then set --tw-shadow and
    // the compiled sheet order decides, which is how the project and branch
    // panels shipped Tailwind's generic shadow.
    expect(cn('shadow-md shadow-[var(--solus-menu-shadow)]').split(' ')).toContain('shadow-md')
  })
})

// ─── Mechanism 3: stock utilities re-declaring a property blank an @utility ──

describe('menu-surface survives the utilities every menu passes alongside it', () => {
  const menuSurface = blocks(indexCss, /@utility\s+menu-surface\s*\{/g)[0] ?? ''

  test('feeds --tw-shadow as well as box-shadow', () => {
    // Every menu passes `ring-0` to cancel a stock ring, and any ring-* utility
    // re-emits box-shadow as Tailwind's composite from a later byte offset. A
    // raw box-shadow is replaced by that composite; --tw-shadow flows through it.
    expect(menuSurface).toContain('box-shadow:')
    expect(
      menuSurface,
      'menu-surface sets box-shadow without --tw-shadow, so ring-0 will blank it.',
    ).toContain('--tw-shadow:')
  })
})

// ─── One merge path, one set of registered keys ──────────────────────────────

test('nothing imports tailwind-merge or tailwind-variants except lib/tw.ts', async () => {
  // `tv` bundles its own tailwind-merge instance, so a stray import reopens the
  // hole for every variant-based primitive. shadcn-svelte generates exactly that
  // import each time a primitive is added.
  const strays: string[] = []
  for await (const file of new Glob('**/*.{svelte,ts}').scan(RENDERER)) {
    if (file === join('lib', 'tw.ts')) continue
    const source = await Bun.file(join(RENDERER, file)).text()
    if (/from\s+["'](tailwind-merge|tailwind-variants)["']/.test(source)) strays.push(file)
  }
  expect(strays, 'Import `cn`/`tv` from @renderer/lib/tw instead.').toEqual([])
})

// ─── Breakpoint-prefixed defaults outlive a call site's override ─────────────

test('menus built on Popover.Content restate text-menu at the primitive\'s breakpoints', async () => {
  // A breakpoint-prefixed class is its own tailwind-merge group, so a bare
  // `text-menu` leaves Popover.Content's `lg:text-[0.9375rem]` standing and the
  // 15px wins on any window past that breakpoint.
  const primitive = await Bun.file(join(RENDERER, 'components/ui/popover/popover-content.svelte')).text()
  const breakpoints = [...primitive.matchAll(/\b(sm|md|lg|xl|2xl):text-\[/g)].map((m) => m[1])

  const gaps: string[] = []
  for await (const file of new Glob('**/*.svelte').scan(RENDERER)) {
    const source = await Bun.file(join(RENDERER, file)).text()
    for (const match of source.matchAll(/<Popover\.Content\b[^>]*?class=(["'])([^"']*?)\1/gs)) {
      const classes = match[2].split(/\s+/)
      if (!classes.includes('text-menu')) continue
      for (const bp of breakpoints) {
        if (!classes.includes(`${bp}:text-menu`)) gaps.push(`${file} is missing ${bp}:text-menu`)
      }
    }
  }
  expect(gaps, 'Popover.Content re-sizes at these breakpoints; a menu has to follow it.').toEqual([])
})
