import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'

// Every menu in the app is built from one row shape, and that shape carries a
// height per pointer/display rung. A rung written as a fixed `h-*` is a trap:
// the row still lays out its content, so a row whose description wraps paints
// its second line *outside* the box, up through whatever sits above it.
//
// That is not hypothetical. The publish menu lists Confluence and Google Drive
// whether or not they are connected, and an unconnected one carries the reason
// ("The connected Atlassian site (…) does not grant Confluence access. Connect
// in Settings…") on a second line. On a laptop display those rows painted up
// through the menu's own "Publish to" label.
//
// The call site cannot fix this alone. Its `h-auto` evicts the base `h-8`
// through tailwind-merge, but the laptop rung is a two-selector variant
// (`[.is-laptop-display_&]:`) — a different merge group and a higher
// specificity — so it survived the override and won the cascade.
//
// These tests pin the invariant, not the pixels: a rung may set a floor, never
// a ceiling.

const UI = new URL('../../packages/workspace-ui/src/', import.meta.url).pathname

// Read as source rather than imported: `menu-row.ts` pulls in `lib/tw`, and the
// package's extensionless subpath export only resolves under Vite.
const menuRow = readFileSync(`${UI}components/ui/menu/menu-row.ts`, 'utf8')
const base = menuRow.match(/base:\s*'([^']+)'/)?.[1]
if (!base) throw new Error('menu-row.ts no longer declares its base class list as a single quoted string')

const classes: string[] = base.split(/\s+/)

/** Every height class the row shape declares, by its variant prefix (`''` = unprefixed). */
const heightRungs = classes
  .filter((cls: string) => /(^|:)h-[^:]+$/.test(cls))
  .map((cls: string) => {
    const at = cls.lastIndexOf(':')
    return { variant: at === -1 ? '' : cls.slice(0, at), value: cls.slice(at + 1) }
  })

describe('menu row height rungs', () => {
  // The unprefixed base is exempt: it is a plain utility, so a call site's
  // `h-auto` merges it away. Only the variant rungs are unreachable from a
  // call site, so only they have to be floors.
  test('no variant rung pins a height a wrapping row cannot escape', () => {
    const pinned = heightRungs.filter((rung) => rung.variant !== '' && rung.value !== 'h-auto')
    expect(pinned).toEqual([])
  })

  // A rung that only says `h-auto` has given up its density: the row would
  // collapse onto its label. Each one has to restate its height as `min-h-*`
  // under the same variant.
  test('each variant rung still states its density as a floor', () => {
    const floors = new Set(
      classes
        .filter((cls: string) => /(^|:)min-h-[^:]+$/.test(cls))
        .map((cls: string) => cls.slice(0, cls.lastIndexOf(':'))),
    )
    for (const rung of heightRungs) {
      if (rung.variant === '') continue
      expect(floors).toContain(rung.variant)
    }
  })
})

// The publish menu no longer carries its reasons inline. Held on a second line
// they wrapped to three at the 14px rung — the menu is capped at 22rem, and "No
// Atlassian site is connected. Connect in Settings…" needs more than that — so
// each provider became a 71px slab. Two of those left the "Publish to" heading
// closer to the first row (11px) than the rows were to each other (14.5px), and
// the heading read as part of the first block rather than as a label above the
// list. The reason is a tooltip now and every provider is one line.
//
// The rung invariant above is unaffected: it guards every menu in the app, and
// a wrapping row is still a thing a rung must not clamp.
describe('publish menu provider rows', () => {
  const source = readFileSync(`${UI}components/work/WorkPublishMenu.svelte`, 'utf8')

  test('a provider that cannot be published to states why in a tooltip', () => {
    expect(source).toContain('<TooltipUI.Content')
    expect(source).toContain('${status.reason} Connect in Settings…')
  })

  // The defect this replaced: prose inside the row. If a reason ever goes back
  // inline the row grows again and the heading loses its separation, so the
  // wrapping affordance staying gone is the thing worth pinning.
  test('no provider row carries its reason inline', () => {
    expect(source).not.toContain('h-auto py-1.5')
    expect(source).not.toContain('whitespace-normal text-(--solus-text-tertiary)')
  })

  // `disabled` would pair with `pointer-events-none` from `menuRowVariants` and
  // drop the row out of keyboard navigation — taking the tooltip, and with it
  // the only statement of why the provider is unusable, away from both a hover
  // and an arrow key. `aria-disabled` says the same thing and keeps it
  // reachable.
  test('an unreachable provider stays hoverable and focusable', () => {
    expect(source).toContain('aria-disabled={!status.connectable}')
    expect(source).not.toMatch(/data-testid=\{`unavailable-\$\{status\.provider\}`\}\s+disabled/)
  })

  test('both provider states are still distinguishable to a test and a user', () => {
    expect(source).toContain('`connect-${status.provider}`')
    expect(source).toContain('`unavailable-${status.provider}`')
    expect(source).toContain('aria-disabled:opacity-50')
  })
})
