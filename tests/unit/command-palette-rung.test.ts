import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'

/**
 * The command palette holds one size on every display.
 *
 * It is a decision surface — a user summons it, reads a list, and picks. That
 * is the same argument that keeps `--text-menu` off the laptop step in
 * `index.css`, so the palette takes that rung rather than the workspace chrome
 * rung, which steps 14px → 12px on a precise-pointer laptop.
 *
 * The row is the half that is easy to lose. `menuRowVariants` is shared with
 * every dropdown and context menu in the app, and it steps its own height, gap,
 * radius and padding on a laptop. Those steps carry a modifier prefix, which is
 * its own tailwind-merge group: the palette's unprefixed `h-[2.625rem]` does not
 * evict `pointer-fine:[.is-laptop-display_&]:h-7`, so the primitive wins on a
 * laptop and the row shrinks under type that did not. The call site has to
 * restate each stepped property behind the same modifier.
 *
 * Asserted against the sources because the rule is about which classes are
 * written, not what a given display resolves them to.
 */
const UI_ROOT = join(import.meta.dir, '../../packages/workspace-ui/src')
const PALETTE = readFileSync(
  join(UI_ROOT, 'components/command-palette/CommandPalette.svelte'),
  'utf8',
)
const MENU_ROW = readFileSync(join(UI_ROOT, 'components/ui/menu/menu-row.ts'), 'utf8')

const LAPTOP_MODIFIER = 'pointer-fine:[.is-laptop-display_&]:'

/** The utility's property, e.g. `h-7` → `h`, `rounded-md` → `rounded`. */
function property(utility: string): string {
  return utility.split('-')[0]
}

function laptopUtilities(source: string): string[] {
  return [...source.matchAll(/pointer-fine:\[\.is-laptop-display_&\]:(\S+?)(?=['" ])/g)].map(
    (match) => match[1],
  )
}

describe('the command palette does not step on a laptop display', () => {
  test('the panel takes the menu rung, not the stepping chrome rung', () => {
    expect(PALETTE).toContain('text-menu')
    expect(PALETTE).not.toContain('text-workspace-chrome')
  })

  test('the row restates every property the shared menu row steps', () => {
    // Only what the palette's own row picks up: the base list plus the default
    // `indicator: 'none'` padding. The `trailing` variant belongs to menus that
    // reserve room for a check mark.
    const applied = [
      MENU_ROW.match(/base:\s*'([^']*)'/)?.[1] ?? '',
      MENU_ROW.match(/none:\s*'([^']*)'/)?.[1] ?? '',
    ].join(' ')
    const stepped = laptopUtilities(applied)
    // A guard on the guard: if the primitive stops stepping, this test is
    // asserting nothing and should be deleted rather than left green.
    expect(stepped.length).toBeGreaterThan(0)

    const restated = new Set(laptopUtilities(PALETTE).map(property))
    for (const utility of stepped) {
      expect({ property: property(utility), restated: restated.has(property(utility)) }).toEqual({
        property: property(utility),
        restated: true,
      })
    }
  })

  test('each restatement matches the size the palette uses at every other width', () => {
    for (const utility of laptopUtilities(PALETTE)) {
      expect(PALETTE).toContain(` ${utility}`)
      expect(PALETTE.includes(`${LAPTOP_MODIFIER}${utility}`)).toBe(true)
    }
  })
})
