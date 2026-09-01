import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, test } from 'bun:test'

/**
 * Two rules about right-click menus, which are one rule seen from two sides.
 *
 * A context menu is chrome, so its rows step down on a laptop display exactly
 * like the band that opened them. That step is `--text-menu`, and the *only*
 * reason a single token can move every menu in the app is that every menu is
 * the same component: `components/ui/context-menu`, whose rows take
 * `menuRowVariants()` and whose surface takes `menu-surface`.
 *
 * The failure this pins is not "a menu looked big". It is the two ways the
 * single-token property gets lost:
 *
 *   1. A surface builds its own menu — straight off `bits-ui`, or out of raw
 *      buttons — and is simply not on the rung. Twelve menus reached the shared
 *      primitive one at a time; the thirteenth is the regression.
 *   2. A menu component hard-codes a size, which pins that one menu to a fixed
 *      width the display cannot step, and the app's menus disagree with each
 *      other on a laptop.
 *
 * Asserted against the sources because that is where the rule lives: there is
 * no runtime object that knows "every menu". Both halves must hold — a shared
 * component whose rung a call site overrides is no better than a bespoke one.
 */
const UI_ROOT = join(import.meta.dir, '../../packages/workspace-ui/src')
const PRIMITIVE_DIR = join(UI_ROOT, 'components/ui/context-menu')

function svelteFilesUnder(dir: string): string[] {
  const found: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) found.push(...svelteFilesUnder(path))
    else if (entry.name.endsWith('.svelte')) found.push(path)
  }
  return found
}

const ALL_COMPONENTS = svelteFilesUnder(join(UI_ROOT, 'components')).map(
  (path) => ({
    repoPath: relative(UI_ROOT, path),
    source: readFileSync(path, 'utf8'),
  }),
)

/**
 * The menus themselves — the components that render context-menu markup, as
 * opposed to the call sites that merely position one. A call site owning
 * coordinates and an `oncontextmenu` handler is fine; a call site owning *rows*
 * is the defect.
 */
const MENU_COMPONENTS = ALL_COMPONENTS.filter(
  ({ repoPath, source }) =>
    !repoPath.startsWith('components/ui/context-menu') &&
    source.includes('ui/context-menu'),
)

describe('every right-click context menu is the same component', () => {
  test('the menus exist and are found', () => {
    // Guards the assertions below from passing vacuously if the primitive is
    // ever moved or the import path is rewritten out from under the filter.
    expect(MENU_COMPONENTS.length).toBeGreaterThanOrEqual(12)
  })

  test("only the primitive touches bits-ui's context menu", () => {
    // WHY: reaching past `components/ui/context-menu` is how a menu ends up off
    // the rung while still looking like a menu — it gets bits-ui's own
    // unstyled Content and Item, so it inherits the bare root size instead of
    // `--text-menu`, and no edit to the token can reach it.
    const offenders = ALL_COMPONENTS.filter(
      ({ repoPath, source }) =>
        !repoPath.startsWith('components/ui/context-menu') &&
        /import\s*\{[^}]*\bContextMenu\b[^}]*\}\s*from\s*["']bits-ui["']/.test(
          source,
        ),
    ).map(({ repoPath }) => repoPath)
    expect(offenders).toEqual([])
  })

  test('no menu hard-codes a font size over the rung', () => {
    // WHY: the primitive spreads a call site's `class` last, so any size a menu
    // component sets wins against `menuRowVariants()`. One menu pinned to
    // `text-xs` is a menu that no longer agrees with the eleven beside it the
    // moment the display changes.
    const offenders: string[] = []
    for (const { repoPath, source } of MENU_COMPONENTS) {
      for (const [index, line] of source.split('\n').entries()) {
        const hit = line.match(
          /\btext-(?:xs|sm|base|lg|[2-9]?xl|\[[^\]]*\])|font-size/,
        )
        if (hit) offenders.push(`${repoPath}:${index + 1} ${hit[0]}`)
      }
    }
    expect(offenders).toEqual([])
  })
})

describe('the menu rung', () => {
  test('is what a context menu row and submenu trigger are sized by', () => {
    // WHY: `menuRowVariants()` is the single carrier of `text-menu`. A row that
    // stops taking it keeps its padding and its hover wash — it still looks
    // like a menu row — and silently falls back to the inherited size.
    for (const file of ['context-menu-item.svelte', 'context-menu-sub-trigger.svelte']) {
      const source = readFileSync(join(PRIMITIVE_DIR, file), 'utf8')
      expect(source).toContain('menuRowVariants')
    }
    const rowVariants = readFileSync(
      join(UI_ROOT, 'components/ui/menu/menu-row.ts'),
      'utf8',
    )
    expect(rowVariants).toContain('text-menu')
  })

  test('is one size on every display, and survives tailwind-merge', () => {
    // WHY: a custom @theme font-size key tailwind-merge does not know is read
    // as a colour and dropped against the `text-(--solus-text-secondary)` that
    // follows it on every menu row — the class compiles, reaches nothing, and
    // the rows take the bare root size. Declaring the rung is only half of it.
    //
    // The rung itself no longer steps: at 12px the label is already at the
    // laptop chrome rung, and stepping it again puts a menu under the band that
    // opened it. A re-declaration inside the laptop block is the regression.
    const css = readFileSync(join(UI_ROOT, 'index.css'), 'utf8')
    // The rung block only — bounded at its own closing brace, or the tokens
    // declared further down the file would read as laptop declarations.
    const rungStart = css.indexOf('html.is-laptop-display {')
    const laptopBlock = css.slice(rungStart, css.indexOf('\n  }', rungStart))
    expect(laptopBlock).toContain('--text-workspace-chrome:')
    expect(css).toContain('--text-menu:')
    expect(laptopBlock).not.toContain('--text-menu:')
    expect(laptopBlock).not.toContain('--text-chrome-shelf:')
    expect(readFileSync(join(UI_ROOT, 'lib/tw.ts'), 'utf8')).toContain(
      "'text-menu'",
    )
  })

  test('carries the row geometry with it, and spares touch', () => {
    // WHY: stepping the label alone just grows the empty band around it — a
    // 32px row holding 11px type reads as a desktop menu someone zoomed out,
    // which is exactly the complaint. Height, gap, radius and inset step
    // together or none of them should. `pointer-fine` is not decoration: a 28px
    // row is under the hit target a finger needs, so the step must never reach
    // a touch client.
    const rowVariants = readFileSync(
      join(UI_ROOT, 'components/ui/menu/menu-row.ts'),
      'utf8',
    )
    for (const step of ['h-7', 'gap-2', 'rounded-md', 'px-2']) {
      expect(rowVariants).toContain(
        `pointer-fine:[.is-laptop-display_&]:${step}`,
      )
    }
    const laptopSteps = rowVariants.match(/\[\.is-laptop-display_&\]:/g) ?? []
    const guarded = rowVariants.match(/pointer-fine:\[\.is-laptop-display_&\]:/g) ?? []
    expect(guarded.length).toBe(laptopSteps.length)
  })

  test('is not stepped on the shared surface, which call sites overrule', () => {
    // WHY: ten menus restate their own radius over `menu-surface` and mean it —
    // one is deliberately 8px where the pickers are 16px. A step written inside
    // the utility compiles to `html.is-laptop-display .menu-surface`, which
    // outranks all ten and *inflates* the 8px menu on a laptop. The step has to
    // be opt-in on the surfaces that want it.
    const css = readFileSync(join(UI_ROOT, 'index.css'), 'utf8')
    const surface = css
      .slice(css.indexOf('@utility menu-surface'), css.indexOf('@utility menu-row'))
      // Declarations only — the comment above the radius explains this very
      // trap, and naming it must not be what trips the check.
      .replace(/\/\*[\s\S]*?\*\//g, '')
    expect(surface).not.toContain('is-laptop-display')
  })

  test('does not step the right-click menu geometry — only its type', () => {
    // WHY: the right-click menu is the one menu a user summons over their own
    // content, so a laptop step there reads as a menu that shrank away from the
    // pointer rather than as chrome. Product decision: the row keeps its desktop
    // height, gap, radius, padding, icon and inset on a laptop, and only
    // `--text-menu` steps. The rows take `menuRowVariants()`, which does step,
    // so the restatement below is what holds the decision — remove it and the
    // shared row silently shrinks the menu again.
    for (const [file, step] of [
      ['context-menu-item.svelte', 'h-8'],
      ['context-menu-item.svelte', 'gap-2.5'],
      ['context-menu-item.svelte', 'rounded-lg'],
      ['context-menu-item.svelte', 'px-2.5'],
      ['context-menu-sub-trigger.svelte', 'h-8'],
      ['context-menu-sub-trigger.svelte', 'gap-2.5'],
      ['context-menu-sub-trigger.svelte', 'rounded-lg'],
      ['context-menu-sub-trigger.svelte', 'px-2.5'],
    ] as const) {
      expect(readFileSync(join(PRIMITIVE_DIR, file), 'utf8')).toContain(
        `pointer-fine:[.is-laptop-display_&]:${step}`,
      )
    }
    // The surfaces and the separator carry no step at all.
    for (const file of [
      'context-menu-content.svelte',
      'context-menu-sub-content.svelte',
      'context-menu-separator.svelte',
    ]) {
      expect(readFileSync(join(PRIMITIVE_DIR, file), 'utf8')).not.toContain(
        'is-laptop-display',
      )
    }
  })

  test('reaches a portalled menu, which inherits nothing from its opener', () => {
    // WHY: bits-ui mounts the surface on document.body, outside #root. Both the
    // content and the submenu content must declare a rung themselves or they
    // resolve against the bare 16px root — the rows would step on a laptop
    // while the surface around them did not.
    for (const file of ['context-menu-content.svelte', 'context-menu-sub-content.svelte']) {
      const source = readFileSync(join(PRIMITIVE_DIR, file), 'utf8')
      expect(source).toContain('menu-surface')
    }
  })
})
